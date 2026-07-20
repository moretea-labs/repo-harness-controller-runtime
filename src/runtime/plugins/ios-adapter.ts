import { join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import {
  iosAppBuild,
  iosAppInstall,
  iosAppLaunch,
  iosDevelopmentPlatform,
  iosProjectDiscover,
  iosSchemesList,
  iosSimulatorBoot,
  iosSimulatorScreenshot,
  iosSimulatorsList,
  iosSmokeReview,
  iosXcodeStatus,
} from '../safe-tooling/ios-development';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import {
  executeIosAgentDeviceAction,
  iosAgentDeviceActions,
  iosAgentDeviceCapabilities,
  iosAgentDeviceStatus,
  isIosAgentDeviceAction,
} from './ios-agent-device';
import {
  executeIosPhysicalDeviceAction,
  iosPhysicalDeviceActions,
  iosPhysicalDeviceCapabilities,
  iosPhysicalDeviceStatus,
  isIosPhysicalDeviceAction,
} from './ios-physical-device';

const IOS_PLUGIN_ID = 'ios';
const CONFIG_ROOT = '.repo-harness/plugins';

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function repositoryFromInput(input: AssistantPluginActionExecutionInput): RepositoryRecord {
  return {
    repoId: input.repoId,
    canonicalRoot: input.repoRoot,
    activeCheckoutId: 'active',
  } as RepositoryRecord;
}

function controllerArtifactRoot(input: AssistantPluginActionExecutionInput): string {
  return join(repositoryControllerRoot(input.controllerHome, input.repoId), 'artifacts', 'ios');
}

function userFacingIosStatus(): Record<string, unknown> {
  const xcode = iosXcodeStatus();
  const discovery = iosProjectDiscover({
    repoId: 'probe',
    canonicalRoot: process.cwd(),
    activeCheckoutId: 'active',
  } as RepositoryRecord);
  if (xcode && 'ready' in xcode && !xcode.ready && 'error' in xcode) {
    return { status: 'not_configured', label: 'not configured', xcodeReady: false };
  }
  const ready = Boolean(xcode && 'ready' in xcode && xcode.ready);
  const discoverable = Boolean(discovery.ready);
  let status = 'not_configured';
  if (ready && discoverable) status = 'buildable';
  else if (ready) status = 'simulator_ready';
  else if (discoverable) status = 'discoverable';
  return {
    status,
    label: status.replace(/_/g, ' '),
    xcodeReady: ready,
    discoverable,
    simctlAvailable: Boolean(xcode && 'simctlAvailable' in xcode && xcode.simctlAvailable),
  };
}

function health(repoRoot: string): AssistantPluginHealth {
  const xcode = iosXcodeStatus();
  const discovery = iosProjectDiscover({
    repoId: 'probe',
    canonicalRoot: repoRoot,
    activeCheckoutId: 'active',
  } as RepositoryRecord);
  const currentPlatform = iosDevelopmentPlatform();
  const platformOk = currentPlatform === 'darwin';
  const toolingReady = platformOk && Boolean(xcode && 'ready' in xcode && xcode.ready);
  const warnings: string[] = [];
  if (!platformOk) warnings.push('iOS plugin requires macOS with Xcode and Simulator.');
  if (platformOk && !toolingReady) warnings.push('Xcode/simctl is not fully ready on this host.');
  if (!discovery.ready) warnings.push('No .xcworkspace/.xcodeproj/Package.swift discovered in this repository yet.');
  const status = userFacingStatusFrom(toolingReady, discovery.ready, Boolean(xcode && 'simctlAvailable' in xcode && xcode.simctlAvailable));
  return {
    state: !platformOk ? 'disabled' : toolingReady ? 'ready' : 'degraded',
    checkedAt: now(),
    ready: toolingReady,
    probed: true,
    errors: [],
    warnings,
    details: {
      provider: 'local-xcode',
      platform: currentPlatform,
      userFacingStatus: status,
      discoverable: discovery.ready,
      defaultContainer: discovery.defaultContainer,
      xcode: xcode && 'ready' in xcode ? {
        ready: xcode.ready,
        xcodeSelectPath: 'xcodeSelectPath' in xcode ? xcode.xcodeSelectPath : undefined,
        xcodebuildVersion: 'xcodebuildVersion' in xcode ? xcode.xcodebuildVersion : undefined,
        simctlAvailable: 'simctlAvailable' in xcode ? xcode.simctlAvailable : undefined,
      } : xcode,
      agentDevice: iosAgentDeviceStatus(),
      physicalDevice: iosPhysicalDeviceStatus(),
      artifactRoots: {
        repoLocal: '.repo-harness/ios/',
        controller: 'controller-home/repositories/<repoId>/artifacts/ios/',
      },
    },
  };
}

function userFacingStatusFrom(toolingReady: boolean, discoverable: boolean, simReady: boolean): string {
  if (!toolingReady && !discoverable) return 'not_configured';
  if (discoverable && toolingReady && simReady) return 'buildable';
  if (toolingReady && simReady) return 'simulator_ready';
  if (discoverable) return 'discoverable';
  if (toolingReady) return 'simulator_ready';
  return 'not_configured';
}

function permissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    { scope: 'ios.discover', mode: 'read', description: 'Discover Xcode projects, schemes, and simulator inventory.', granted: ready, required: true },
    { scope: 'ios.build', mode: 'write', description: 'Build iOS app targets into bounded DerivedData.', granted: ready, required: true },
    { scope: 'ios.simulator', mode: 'write', description: 'Boot simulators, install, launch, screenshot, and collect logs.', granted: ready, required: true },
    { scope: 'ios.device', mode: 'write', description: 'Inspect and interact with an exact paired physical iPhone through bounded CoreDevice and optional signed UI-runner actions.', granted: ready, required: false },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'ios-discovery',
      title: 'iOS Project Discovery',
      description: 'Discover workspaces, projects, schemes, and simulator readiness.',
      scopes: ['ios.discover'],
      actions: ['discover_project', 'list_schemes', 'xcode_status', 'list_simulators'],
    },
    {
      capabilityId: 'ios-smoke-review',
      title: 'iOS Staged Smoke Review',
      description: 'Run a staged build/install/launch/screenshot workflow with per-stage evidence.',
      scopes: ['ios.build', 'ios.simulator'],
      actions: ['smoke_review', 'build', 'launch_simulator', 'capture_screenshot'],
    },
    ...iosAgentDeviceCapabilities(),
    ...iosPhysicalDeviceCapabilities(),
  ];
}

function actions(): AssistantPluginActionDescriptor[] {
  const readClaims = [{ resource: 'workspace' as const, mode: 'read' as const }];
  const writeClaims = [
    { resource: 'workspace' as const, mode: 'write' as const },
    { resource: 'repo-state' as const, mode: 'write' as const },
  ];
  return [
    {
      actionId: 'xcode_status',
      title: 'Xcode status',
      description: 'Report local Xcode and simctl readiness.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: true,
      scopes: ['ios.discover'],
      resourceClaims: [],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'list_simulators',
      title: 'List simulators',
      description: 'List available iOS Simulator devices.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['ios.discover'],
      resourceClaims: [],
      argumentsSchema: {
        type: 'object',
        properties: {
          runtime: { type: 'string' },
          name: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'discover_project',
      title: 'Discover iOS project',
      description: 'Discover .xcworkspace, .xcodeproj, Package.swift, and Info.plist paths.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 15_000,
      cancellable: true,
      idempotent: true,
      scopes: ['ios.discover'],
      resourceClaims: readClaims,
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'list_schemes',
      title: 'List schemes',
      description: 'List Xcode schemes for the discovered workspace or project.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      scopes: ['ios.discover'],
      resourceClaims: readClaims,
      argumentsSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          project: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'build',
      title: 'Build iOS app',
      description: 'Build an iOS scheme into bounded DerivedData with structured command evidence.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 10 * 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['ios.build'],
      resourceClaims: writeClaims,
      argumentsSchema: {
        type: 'object',
        properties: {
          scheme: { type: 'string' },
          udid: { type: 'string' },
          simulator_name: { type: 'string' },
          workspace: { type: 'string' },
          project: { type: 'string' },
          configuration: { type: 'string' },
          timeout_ms: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'launch_simulator',
      title: 'Boot simulator',
      description: 'Boot an iOS Simulator device.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      scopes: ['ios.simulator'],
      resourceClaims: writeClaims,
      argumentsSchema: {
        type: 'object',
        properties: {
          udid: { type: 'string' },
          open_simulator: { type: 'boolean' },
          timeout_ms: { type: 'number' },
        },
        required: ['udid'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'capture_screenshot',
      title: 'Capture simulator screenshot',
      description: 'Capture a simulator screenshot into controller artifact storage.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'none',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['ios.simulator'],
      resourceClaims: writeClaims,
      argumentsSchema: {
        type: 'object',
        properties: {
          udid: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['udid'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'smoke_review',
      title: 'Staged iOS smoke review',
      description: 'Run project discovery → scheme → build → boot → install → launch → screenshot → logs with per-stage status.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 15 * 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['ios.build', 'ios.simulator'],
      resourceClaims: writeClaims,
      argumentsSchema: {
        type: 'object',
        properties: {
          scheme: { type: 'string' },
          bundle_id: { type: 'string' },
          udid: { type: 'string' },
          simulator_name: { type: 'string' },
          workspace: { type: 'string' },
          project: { type: 'string' },
          configuration: { type: 'string' },
          app_path: { type: 'string' },
          screenshot_label: { type: 'string' },
          skip_build: { type: 'boolean' },
          launch_wait_ms: { type: 'number' },
          cleanup_policy: { type: 'string', enum: ['keep', 'shutdown_on_success', 'shutdown_always'] },
        },
        additionalProperties: false,
      },
    },
    ...iosAgentDeviceActions(),
    ...iosPhysicalDeviceActions(),
  ];
}

export function buildIosPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const state = health(repoRoot ?? process.cwd());
  const enabled = iosDevelopmentPlatform() === 'darwin';
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: IOS_PLUGIN_ID,
    provider: 'apple-local',
    displayName: 'iOS Development Plugin',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: ['local:xcodebuild', 'local:simctl', 'local:devicectl', 'local:agent-device@0.19.3', 'process-env:DEVELOPER_DIR', 'process-env:AGENT_DEVICE_IOS_TEAM_ID', 'process-env:AGENT_DEVICE_IOS_BUNDLE_ID', 'process-env:REPO_HARNESS_IOS_DEVICE_RUNNER_URL', `repo-local:${CONFIG_ROOT}/ios.json`],
    },
    enabled,
    lifecycle: {
      state: !enabled ? 'disabled' : state.ready ? 'enabled' : 'degraded',
      reason: !enabled
        ? 'iOS plugin is only available on macOS hosts.'
        : state.ready
          ? 'Xcode and Simulator tooling are ready.'
          : state.warnings[0] ?? 'iOS tooling is partially available.',
    },
    health: state,
    permissions: permissions(state.ready),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeIosPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  if (isIosAgentDeviceAction(input.actionId)) return executeIosAgentDeviceAction(input);
  if (isIosPhysicalDeviceAction(input.actionId)) return executeIosPhysicalDeviceAction(input);
  const currentPlatform = iosDevelopmentPlatform();
  if (currentPlatform !== 'darwin' && input.actionId !== 'discover_project' && input.actionId !== 'xcode_status') {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'iOS plugin actions require macOS with Xcode/Simulator.', {
      retryable: false,
      details: { platform: currentPlatform },
    });
  }

  const repository = repositoryFromInput(input);
  const artifactRoot = controllerArtifactRoot(input);

  switch (input.actionId) {
    case 'xcode_status':
      return { ...iosXcodeStatus(), userFacingStatus: userFacingIosStatus() };
    case 'list_simulators':
      return { ...iosSimulatorsList({ runtime: stringValue(input.args.runtime), name: stringValue(input.args.name) }) };
    case 'discover_project':
      return { ...iosProjectDiscover(repository) };
    case 'list_schemes':
      return {
        ...iosSchemesList(repository, {
          workspace: stringValue(input.args.workspace),
          project: stringValue(input.args.project),
        }),
      };
    case 'build':
      return {
        ...iosAppBuild(repository, {
          scheme: stringValue(input.args.scheme),
          udid: stringValue(input.args.udid),
          simulatorName: stringValue(input.args.simulator_name),
          workspace: stringValue(input.args.workspace),
          project: stringValue(input.args.project),
          configuration: stringValue(input.args.configuration),
          timeoutMs: typeof input.args.timeout_ms === 'number' ? input.args.timeout_ms : undefined,
        }),
      };
    case 'launch_simulator': {
      const udid = stringValue(input.args.udid);
      if (!udid) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'udid is required.', { retryable: false });
      return {
        ...iosSimulatorBoot({
          udid,
          openSimulator: input.args.open_simulator !== false,
          timeoutMs: typeof input.args.timeout_ms === 'number' ? input.args.timeout_ms : undefined,
        }),
      };
    }
    case 'capture_screenshot': {
      const udid = stringValue(input.args.udid);
      if (!udid) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'udid is required.', { retryable: false });
      const screenshot = iosSimulatorScreenshot(repository, {
        udid,
        label: stringValue(input.args.label),
        artifactRoot,
      });
      return {
        ...screenshot,
        artifactCandidates: screenshot && 'absolutePath' in screenshot && typeof screenshot.absolutePath === 'string'
          ? [{ kind: 'ios_simulator_screenshot', mediaType: 'image/png', path: screenshot.absolutePath }]
          : [],
      };
    }
    case 'smoke_review': {
      const review = iosSmokeReview(repository, {
          scheme: stringValue(input.args.scheme),
          bundleId: stringValue(input.args.bundle_id),
          udid: stringValue(input.args.udid),
          simulatorName: stringValue(input.args.simulator_name),
          workspace: stringValue(input.args.workspace),
          project: stringValue(input.args.project),
          configuration: stringValue(input.args.configuration),
          appPath: stringValue(input.args.app_path),
          screenshotLabel: stringValue(input.args.screenshot_label),
          skipBuild: input.args.skip_build === true,
          launchWaitMs: typeof input.args.launch_wait_ms === 'number' ? input.args.launch_wait_ms : undefined,
          cleanupPolicy: ['keep', 'shutdown_on_success', 'shutdown_always'].includes(String(input.args.cleanup_policy))
            ? input.args.cleanup_policy as 'keep' | 'shutdown_on_success' | 'shutdown_always'
            : undefined,
        artifactRoot,
      });
      const screenshotPath = review.screenshot && typeof review.screenshot === 'object' && 'absolutePath' in review.screenshot
        ? String((review.screenshot as { absolutePath?: string }).absolutePath ?? '')
        : '';
      const logPath = review.logs && typeof review.logs === 'object' && 'absolutePath' in review.logs
        ? String((review.logs as { absolutePath?: string }).absolutePath ?? '')
        : '';
      return {
        ...review,
        artifactCandidates: [
          ...(screenshotPath ? [{ kind: 'ios_simulator_screenshot', mediaType: 'image/png', path: screenshotPath }] : []),
          ...(logPath ? [{ kind: 'ios_simulator_log', mediaType: 'text/plain', path: logPath }] : []),
        ],
      };
    }
    // Internal helpers kept for completeness / direct use
    case 'install': {
      const udid = stringValue(input.args.udid);
      const appPath = stringValue(input.args.app_path);
      if (!udid || !appPath) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'udid and app_path are required.', { retryable: false });
      return { ...iosAppInstall(repository, { udid, appPath }) };
    }
    case 'launch_app': {
      const udid = stringValue(input.args.udid);
      const bundleId = stringValue(input.args.bundle_id);
      if (!udid || !bundleId) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'udid and bundle_id are required.', { retryable: false });
      return { ...iosAppLaunch({ udid, bundleId }) };
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `ios/${input.actionId} is not supported.`, { retryable: false });
  }
}

export const iosPluginAdapter = {
  pluginId: IOS_PLUGIN_ID,
  buildManifest: buildIosPluginManifest,
  executeAction: executeIosPluginAction,
};
