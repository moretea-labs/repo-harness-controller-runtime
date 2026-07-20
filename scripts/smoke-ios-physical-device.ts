import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { executeIosPluginAction } from '../src/runtime/plugins/ios-adapter';

const repoRoot = process.cwd();

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && typeof process.argv[index + 1] === 'string'
    ? process.argv[index + 1]!.trim()
    : undefined;
}

const repoId = option('--repo-id') ?? process.env.REPO_HARNESS_IOS_DEVICE_SMOKE_REPO_ID?.trim();
const deviceSelector = option('--device') ?? process.env.REPO_HARNESS_IOS_DEVICE_SMOKE_DEVICE?.trim();
const bundleId = option('--bundle-id') ?? process.env.REPO_HARNESS_IOS_DEVICE_SMOKE_BUNDLE_ID?.trim();
const controllerHome = option('--controller-home') ?? process.env.REPO_HARNESS_CONTROLLER_HOME?.trim()
  ?? `${repoRoot}/_ops/controller-home/runtime-slots/blue`;

if (!repoId || !deviceSelector || !bundleId) {
  throw new Error('Pass --repo-id, --device, and --bundle-id, or set the corresponding REPO_HARNESS_IOS_DEVICE_SMOKE_* environment variables.');
}
if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId) || !bundleId.includes('.') || bundleId.includes('://')) {
  throw new Error('REPO_HARNESS_IOS_DEVICE_SMOKE_BUNDLE_ID must be an exact bundle identifier, not a URL or deep link.');
}

delete process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL;

const common = {
  controllerHome,
  repoId,
  repoRoot,
  pluginId: 'ios',
  origin: { surface: 'local-ui' as const, actor: 'physical-ios-live-smoke' },
};

async function invoke(actionId: string, args: Record<string, unknown>) {
  return executeIosPluginAction({
    ...common,
    actionId,
    args,
    requestId: `physical-ios-smoke-${actionId}-${Date.now()}`,
  });
}

let interactionId: string | undefined;
try {
  const listed = await invoke('physical_device_list', {});
  const devices = Array.isArray(listed.devices) ? listed.devices as Array<Record<string, unknown>> : [];
  const matches = devices.filter((entry) =>
    entry.identifier === deviceSelector || entry.udid === deviceSelector || entry.name === deviceSelector);
  if (matches.length !== 1) throw new Error(`Expected exactly one physical iPhone for selector ${deviceSelector}; found ${matches.length}.`);
  const device = matches[0]!;
  const apps = await invoke('physical_device_apps', { device: device.identifier, bundle_id: bundleId });
  const installed = Array.isArray(apps.apps) ? apps.apps as Array<Record<string, unknown>> : [];
  if (installed.length !== 1) throw new Error(`The exact bundle identifier ${bundleId} is not installed on the selected iPhone.`);

  const opened = await invoke('physical_device_open', {
    device: device.identifier,
    bundle_id: bundleId,
    relaunch: true,
  });
  const interaction = opened.interaction as Record<string, unknown> | undefined;
  interactionId = typeof interaction?.interactionId === 'string' ? interaction.interactionId : undefined;
  if (!interactionId) throw new Error('The physical provider did not return an interaction id.');

  const screenshot = await invoke('physical_device_screenshot', {
    interaction_id: interactionId,
    label: 'live-smoke',
  });
  const artifacts = Array.isArray(screenshot.artifactCandidates)
    ? screenshot.artifactCandidates as Array<Record<string, unknown>>
    : [];
  const path = typeof artifacts[0]?.path === 'string' ? artifacts[0].path : '';
  if (!path || !existsSync(path)) throw new Error('The physical provider did not create a screenshot artifact.');
  const metadata = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', path], { encoding: 'utf8' }).stdout;
  const width = metadata.match(/pixelWidth:\s*(\d+)/)?.[1];
  const height = metadata.match(/pixelHeight:\s*(\d+)/)?.[1];
  const format = metadata.match(/format:\s*(\S+)/)?.[1];

  const closed = await invoke('physical_device_close', { interaction_id: interactionId });
  interactionId = undefined;
  const app = installed[0]!;
  console.log(JSON.stringify({
    device: {
      name: device.name,
      model: device.model,
      osVersion: device.osVersion,
      paired: device.pairingState === 'paired',
      connected: device.connected === true,
      screenshotAvailable: device.screenshotAvailable === true,
    },
    app: {
      installed: true,
      name: app.name,
      bundleVersion: app.bundleVersion,
      version: app.version,
    },
    launchStatus: interaction?.status,
    uiAutomation: opened.uiAutomation,
    screenshot: {
      created: true,
      width: width ? Number(width) : undefined,
      height: height ? Number(height) : undefined,
      format,
    },
    closeStatus: (closed.interaction as Record<string, unknown> | undefined)?.status,
    deviceUnmodified: closed.deviceUnmodified === true,
  }, null, 2));
} finally {
  if (interactionId) {
    try { await invoke('physical_device_close', { interaction_id: interactionId }); } catch {}
  }
}
