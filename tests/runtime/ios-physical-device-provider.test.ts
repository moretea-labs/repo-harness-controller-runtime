import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { buildIosPluginManifest, executeIosPluginAction } from '../../src/runtime/plugins/ios-adapter';
import {
  iosPhysicalDeviceActions,
  resetIosPhysicalDeviceRuntimeHooksForTest,
  setIosPhysicalDeviceRuntimeHooksForTest,
  type RunnerHttpResult,
} from '../../src/runtime/plugins/ios-physical-device';
import { patchInteractionSession, readInteractionSession } from '../../src/runtime/plugins/interaction-session';
import { resetIosDevelopmentHooksForTest, setIosDevelopmentHooksForTest } from '../../src/runtime/safe-tooling';

const roots: string[] = [];

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-ios-physical-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ios-physical-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(repoRoot, 'App.xcodeproj'), { recursive: true });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

function readyIosTooling(): void {
  setIosDevelopmentHooksForTest({
    platform: () => 'darwin',
    runCommand: (command, args) => {
      const joined = [command, ...args].join(' ');
      if (joined === 'xcode-select -p') return commandResult(command, args, '/Applications/Xcode.app/Contents/Developer\n');
      if (joined === 'xcodebuild -version') return commandResult(command, args, 'Xcode 26.6\n');
      if (joined === 'xcrun simctl help') return commandResult(command, args, 'help\n');
      return commandResult(command, args, '');
    },
  });
}

function pluginInput(
  value: ReturnType<typeof fixture>,
  actionId: string,
  args: Record<string, unknown>,
  requestId = `request-${actionId}`,
) {
  return {
    controllerHome: value.controllerHome,
    repoId: value.repository.repoId,
    repoRoot: value.repoRoot,
    pluginId: 'ios',
    actionId,
    requestId,
    args,
    origin: { surface: 'local-ui' as const, actor: 'test' },
  };
}

function commandResult(command: string, args: string[], stdout: string, ok = true, stderr = '') {
  return { ok, status: ok ? 0 : 1, stdout, stderr, command: [command, ...args] };
}

function coreJson(result: Record<string, unknown>): string {
  return JSON.stringify({ info: { outcome: 'success', jsonVersion: 4 }, result });
}

function physicalDevice(
  identifier = 'CORE-1',
  name = 'greyson',
  options: { connected?: boolean; paired?: boolean; screenshot?: boolean } = {},
) {
  const connected = options.connected !== false;
  return {
    identifier,
    hardwareProperties: {
      reality: 'physical', platform: 'iOS', udid: `UDID-${identifier}`,
      marketingName: 'iPhone 17', productType: 'iPhone18,3',
    },
    deviceProperties: {
      name,
      bootState: connected ? 'booted' : 'shutdown',
      developerModeStatus: 'enabled',
      ddiServicesAvailable: connected,
      osVersionNumber: '27.0', osBuildUpdate: '24A5380h',
    },
    connectionProperties: {
      pairingState: options.paired === false ? 'unpaired' : 'paired',
      tunnelState: connected ? 'connected' : 'unavailable',
      transportType: 'localNetwork',
    },
    capabilities: options.screenshot === false ? [] : [{ name: 'Capture Screenshot' }, { name: 'Launch Application' }],
  };
}

function simulatorDevice() {
  return {
    identifier: 'SIM-1',
    hardwareProperties: { reality: 'simulated', platform: 'iOS', udid: 'SIM-UDID' },
    deviceProperties: { name: 'iPhone 17', bootState: 'booted' },
    connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
    capabilities: [{ name: 'Capture Screenshot' }],
  };
}

function jdApp() {
  return {
    name: 'JD', bundleIdentifier: 'com.360buy.jdmobile',
    bundleVersion: '15.9.30', version: '170613', removable: true,
  };
}

function coreDeviceHooks(options: {
  devices?: unknown[];
  apps?: unknown[];
  commands?: string[][];
  screenshot?: boolean;
  appsError?: string;
} = {}) {
  const devices = options.devices ?? [physicalDevice()];
  const apps = options.apps ?? [jdApp()];
  return {
    platform: () => 'darwin' as NodeJS.Platform,
    now: () => new Date('2026-07-20T04:00:00.000Z'),
    runCommand: (command: string, args: string[]) => {
      options.commands?.push([command, ...args]);
      if (args[0] === 'devicectl' && args[1] === '--version') return commandResult(command, args, '636.3\n');
      if (args.includes('list') && args.includes('devices')) return commandResult(command, args, coreJson({ devices }));
      if (args.includes('info') && args.includes('apps')) {
        return options.appsError
          ? commandResult(command, args, '', false, options.appsError)
          : commandResult(command, args, coreJson({ apps }));
      }
      if (args.includes('process') && args.includes('launch')) {
        return commandResult(command, args, coreJson({ deviceIdentifier: 'CORE-1', process: { processIdentifier: 1234 } }));
      }
      if (args.includes('capture') && args.includes('screenshot')) {
        const destination = args[args.indexOf('--destination') + 1]!;
        if (options.screenshot !== false) writeFileSync(destination, 'png');
        return commandResult(command, args, coreJson({ destination, width: 1206, height: 2622, imageFormat: 'png' }));
      }
      return commandResult(command, args, '', false, `unexpected command: ${[command, ...args].join(' ')}`);
    },
  };
}

afterEach(() => {
  resetIosPhysicalDeviceRuntimeHooksForTest();
  resetIosDevelopmentHooksForTest();
  delete process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL;
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded physical iOS device provider', () => {
  it('keeps base iOS readiness enabled and exposes physical-device status separately', () => {
    const value = fixture();
    readyIosTooling();
    setIosPhysicalDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => commandResult(command, args, '', false, 'devicectl unavailable'),
    });

    const manifest = buildIosPluginManifest(0, undefined, value.repoRoot);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.lifecycle.state).toBe('enabled');
    expect((manifest.health.details?.physicalDevice as Record<string, unknown>).available).toBe(false);
    expect(manifest.permissions.map((permission) => permission.scope)).toContain('ios.device');
    expect(manifest.capabilities.map((capability) => capability.capabilityId)).toContain('ios-physical-device');
    expect(manifest.actions.map((action) => action.actionId)).toContain('physical_device_open');
  });

  it('lists only physical iOS devices and rejects ambiguous or unavailable selection', async () => {
    const value = fixture();
    readyIosTooling();
    let devices: unknown[] = [simulatorDevice(), physicalDevice('CORE-1', 'greyson')];
    setIosPhysicalDeviceRuntimeHooksForTest(coreDeviceHooks({ devices }));

    const listed = await executeIosPluginAction(pluginInput(value, 'physical_device_list', {}));
    expect((listed.devices as unknown[]).length).toBe(1);
    expect(JSON.stringify(listed)).not.toContain('serialNumber');
    expect(JSON.stringify(listed)).not.toContain('ecid');

    devices = [physicalDevice('CORE-1', 'greyson'), physicalDevice('CORE-2', 'greyson')];
    setIosPhysicalDeviceRuntimeHooksForTest(coreDeviceHooks({ devices }));
    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_apps', {
      device: 'greyson', bundle_id: 'com.360buy.jdmobile',
    }))).rejects.toThrow('ambiguous');

    devices = [physicalDevice('CORE-OFF', 'offline', { connected: false })];
    setIosPhysicalDeviceRuntimeHooksForTest(coreDeviceHooks({ devices, appsError: 'CoreDevice tunnel unavailable' }));
    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_apps', {
      device: 'CORE-OFF', bundle_id: 'com.360buy.jdmobile',
    }))).rejects.toThrow('CoreDevice connection is currently unavailable');
  });

  it('uses only typed CoreDevice commands for app lookup, launch, screenshot and close', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosPhysicalDeviceRuntimeHooksForTest(coreDeviceHooks({ commands }));

    const apps = await executeIosPluginAction(pluginInput(value, 'physical_device_apps', {
      device: 'CORE-1', bundle_id: 'com.360buy.jdmobile',
    }));
    expect((apps.apps as Array<Record<string, unknown>>)[0]?.name).toBe('JD');

    const opened = await executeIosPluginAction(pluginInput(value, 'physical_device_open', {
      device: 'CORE-1', bundle_id: 'com.360buy.jdmobile', relaunch: true,
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    expect((opened.interaction as Record<string, unknown>).status).toBe('waiting_for_user');
    expect((opened.uiAutomation as Record<string, unknown>).ready).toBe(false);

    const screenshot = await executeIosPluginAction(pluginInput(value, 'physical_device_screenshot', {
      interaction_id: interactionId, label: 'jd-home',
    }));
    const artifact = (screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]!;
    expect(artifact.kind).toBe('ios_physical_device_screenshot');
    expect(existsSync(String(artifact.path))).toBe(true);
    expect(JSON.stringify(screenshot)).toContain('1206');
    expect(JSON.stringify(screenshot)).toContain('2622');

    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_snapshot', {
      interaction_id: interactionId,
    }))).rejects.toThrow('trusted localhost WDA-compatible endpoint');

    const closed = await executeIosPluginAction(pluginInput(value, 'physical_device_close', {
      interaction_id: interactionId,
    }));
    expect((closed.interaction as Record<string, unknown>).status).toBe('closed');
    expect(closed.deviceUnmodified).toBe(true);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('closed');

    const argv = commands.map((command) => command.join(' ')).join('\n');
    expect(argv).toContain('xcrun devicectl device info apps --device CORE-1 --include-all-apps --bundle-id com.360buy.jdmobile');
    expect(argv).toContain('xcrun devicectl device process launch --device CORE-1 --terminate-existing com.360buy.jdmobile');
    expect(argv).toContain('xcrun devicectl device capture screenshot --device CORE-1 --destination');
    expect(argv).not.toContain('://');
  });

  it('attaches an explicitly configured localhost runner and performs bounded UI actions', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL = 'http://127.0.0.1:8100';
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    setIosPhysicalDeviceRuntimeHooksForTest({
      ...coreDeviceHooks(),
      requestJson: async (method, url, body): Promise<RunnerHttpResult> => {
        requests.push({ method, url, body });
        if (url.endsWith('/status')) return { ok: true, status: 200, body: { value: { ready: true } }, text: '' };
        if (method === 'POST' && url.endsWith('/session')) return { ok: true, status: 200, body: { value: { sessionId: 'WDA-1' } }, text: '' };
        if (url.endsWith('/source')) return { ok: true, status: 200, body: { value: '<App><SearchField name="Search"/></App>' }, text: '' };
        if (url.endsWith('/element')) return { ok: true, status: 200, body: { value: { 'element-6066-11e4-a52e-4f735466cecf': 'E1' } }, text: '' };
        if (url.endsWith('/window/size')) return { ok: true, status: 200, body: { value: { width: 390, height: 844 } }, text: '' };
        return { ok: true, status: 200, body: { value: null }, text: '' };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'physical_device_open', {
      device: 'CORE-1', bundle_id: 'com.360buy.jdmobile',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    expect((opened.uiAutomation as Record<string, unknown>).ready).toBe(true);

    const snapshot = await executeIosPluginAction(pluginInput(value, 'physical_device_snapshot', { interaction_id: interactionId }));
    expect(JSON.stringify(snapshot)).toContain('SearchField');
    await executeIosPluginAction(pluginInput(value, 'physical_device_press', {
      interaction_id: interactionId, target: 'id:Search',
    }));
    const filled = await executeIosPluginAction(pluginInput(value, 'physical_device_fill', {
      interaction_id: interactionId, target: 'id:Search', text: '爱他美卓傲 1段',
    }));
    expect(JSON.stringify(filled)).not.toContain('爱他美卓傲');
    await executeIosPluginAction(pluginInput(value, 'physical_device_scroll', {
      interaction_id: interactionId, direction: 'down', amount: 60,
    }));
    const events = await executeIosPluginAction(pluginInput(value, 'physical_device_events', {
      interaction_id: interactionId, limit: 20,
    }));
    expect(JSON.stringify(events)).not.toContain('爱他美卓傲');
    await executeIosPluginAction(pluginInput(value, 'physical_device_close', { interaction_id: interactionId }));

    expect(requests.some((request) => request.url.endsWith('/WDA-1/source'))).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/element/E1/click'))).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/element/E1/value'))).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/wda/dragfromtoforduration'))).toBe(true);
    expect(requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/session/WDA-1'))).toBe(true);
  });

  it('blocks credentials, verification, biometrics, checkout and payment semantics before runner mutation', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL = 'http://localhost:8100';
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    setIosPhysicalDeviceRuntimeHooksForTest({
      ...coreDeviceHooks(),
      requestJson: async (method, url, body) => {
        requests.push({ method, url, body });
        if (url.endsWith('/status')) return { ok: true, status: 200, body: { value: { ready: true } }, text: '' };
        if (method === 'POST' && url.endsWith('/session')) return { ok: true, status: 200, body: { value: { sessionId: 'WDA-1' } }, text: '' };
        return { ok: true, status: 200, body: { value: null }, text: '' };
      },
    });
    const opened = await executeIosPluginAction(pluginInput(value, 'physical_device_open', {
      device: 'CORE-1', bundle_id: 'com.360buy.jdmobile',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const before = requests.length;

    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_fill', {
      interaction_id: interactionId, target: 'id:短信验证码', text: '123456',
    }))).rejects.toThrow('must be completed manually');
    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_press', {
      interaction_id: interactionId, target: 'id:确认支付',
    }))).rejects.toThrow('must be completed manually');
    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_press', {
      interaction_id: interactionId, x: 100, y: 200, purpose: 'Face ID payment confirmation',
    }))).rejects.toThrow('must be completed manually');
    expect(requests.length).toBe(before);
  });

  it('inspects resolved element semantics and blocks a generic selector that resolves to a secure field', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL = 'http://127.0.0.1:8100';
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    setIosPhysicalDeviceRuntimeHooksForTest({
      ...coreDeviceHooks(),
      requestJson: async (method, url, body) => {
        requests.push({ method, url, body });
        if (url.endsWith('/status')) return { ok: true, status: 200, body: { value: { ready: true } }, text: '' };
        if (method === 'POST' && url.endsWith('/session')) return { ok: true, status: 200, body: { value: { sessionId: 'WDA-SECURE' } }, text: '' };
        if (url.endsWith('/element')) return { ok: true, status: 200, body: { value: { 'element-6066-11e4-a52e-4f735466cecf': 'SECURE-E1' } }, text: '' };
        if (url.endsWith('/attribute/type')) return { ok: true, status: 200, body: { value: 'XCUIElementTypeSecureTextField' }, text: '' };
        return { ok: true, status: 200, body: { value: '' }, text: '' };
      },
    });
    const opened = await executeIosPluginAction(pluginInput(value, 'physical_device_open', {
      device: 'CORE-1', bundle_id: 'com.360buy.jdmobile',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_fill', {
      interaction_id: interactionId, target: 'id:field', text: 'not-recorded',
    }))).rejects.toThrow('must be completed manually');
    expect(requests.some((request) => request.url.endsWith('/attribute/type'))).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/clear'))).toBe(false);
    expect(requests.some((request) => request.url.endsWith('/value'))).toBe(false);
  });

  it('allows terminal sessions to retry runner cleanup without changing device state', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL = 'http://localhost:8100';
    const requests: Array<{ method: string; url: string }> = [];
    setIosPhysicalDeviceRuntimeHooksForTest({
      ...coreDeviceHooks(),
      requestJson: async (method, url) => {
        requests.push({ method, url });
        if (url.endsWith('/status')) return { ok: true, status: 200, body: { value: { ready: true } }, text: '' };
        if (method === 'POST' && url.endsWith('/session')) return { ok: true, status: 200, body: { value: { sessionId: 'WDA-STALE' } }, text: '' };
        return { ok: true, status: 200, body: { value: null }, text: '' };
      },
    });
    const opened = await executeIosPluginAction(pluginInput(value, 'physical_device_open', {
      device: 'CORE-1', bundle_id: 'com.360buy.jdmobile',
    }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    patchInteractionSession(value.repoRoot, 'ios-device', interactionId, {
      status: 'failed', error: { code: 'SIMULATED_STALE', message: 'simulated stale terminal state' },
    });
    const closed = await executeIosPluginAction(pluginInput(value, 'physical_device_close', { interaction_id: interactionId }));
    expect(closed.alreadyClosed).toBe(true);
    expect(closed.runnerCleaned).toBe(true);
    expect(closed.deviceUnmodified).toBe(true);
    expect(requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/session/WDA-STALE'))).toBe(true);
    expect(readInteractionSession(value.repoRoot, 'ios-device', interactionId)?.status).toBe('failed');
  });

  it('rejects remote UI endpoints, deep links, arbitrary command surfaces and unlabelled coordinate presses', async () => {
    const value = fixture();
    readyIosTooling();
    process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL = 'https://example.com:8100';
    setIosPhysicalDeviceRuntimeHooksForTest(coreDeviceHooks());
    const status = await executeIosPluginAction(pluginInput(value, 'physical_device_status', {}));
    expect((status.uiRunner as Record<string, unknown>).ready).toBe(false);
    expect((status.uiRunner as Record<string, unknown>).error).toContain('localhost');

    await expect(executeIosPluginAction(pluginInput(value, 'physical_device_open', {
      device: 'CORE-1', bundle_id: 'jd://product?token=secret',
    }))).rejects.toThrow('not a URL or deep link');

    const actions = Object.fromEntries(iosPhysicalDeviceActions().map((action) => [action.actionId, action]));
    for (const action of Object.values(actions)) {
      expect(action.actionId).not.toContain('mcp');
      expect(JSON.stringify(action.argumentsSchema)).not.toContain('command');
      expect(JSON.stringify(action.argumentsSchema)).not.toContain('argv');
    }
    for (const actionId of ['physical_device_open', 'physical_device_press', 'physical_device_fill', 'physical_device_scroll', 'physical_device_screenshot', 'physical_device_close']) {
      expect(actions[actionId]?.confirmation).toBe('authorization');
      expect(actions[actionId]?.resourceClaims).toContainEqual({ resource: 'repo-state', mode: 'write' });
    }
  });
});
