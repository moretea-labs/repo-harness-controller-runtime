import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { buildIosPluginManifest, executeIosPluginAction } from '../src/runtime/plugins/ios-adapter';

interface AgentDeviceEntry {
  platform?: unknown;
  appleOs?: unknown;
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  target?: unknown;
  booted?: unknown;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function fail(message: string): never {
  throw new Error(message);
}

function parseAgentDeviceJson(stdout: string): Record<string, unknown> {
  try {
    const value = JSON.parse(stdout.trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Structured failure below.
  }
  return fail('agent-device returned unreadable JSON.');
}

const repoRoot = resolve(option('--repo-root') ?? process.cwd());
const repoId = option('--repo-id') ?? fail('--repo-id is required.');
const controllerHome = resolve(
  option('--controller-home')
    ?? process.env.REPO_HARNESS_CONTROLLER_HOME
    ?? join(repoRoot, '_ops/controller-home/runtime-slots/blue'),
);
const deviceSelector = option('--device');
const doctorApp = option('--doctor-app');
const teamId = option('--team-id');
const runnerBundleId = option('--runner-bundle-id');
const developerDir = option('--developer-dir');
const jdQuery = option('--jd-query');
const executable = process.env.REPO_HARNESS_AGENT_DEVICE_EXECUTABLE?.trim() || 'agent-device';

const manifestPath = join(controllerHome, 'repositories', repoId, 'plugins', 'manifests', 'ios.json');
mkdirSync(dirname(manifestPath), { recursive: true });
let previousRevision = 0;
let previousUpdatedAt: string | undefined;
if (existsSync(manifestPath)) {
  const previous = JSON.parse(readFileSync(manifestPath, 'utf8')) as { revision?: unknown; updatedAt?: unknown };
  previousRevision = typeof previous.revision === 'number' ? previous.revision : 0;
  previousUpdatedAt = typeof previous.updatedAt === 'string' ? previous.updatedAt : undefined;
}
const manifest = buildIosPluginManifest(previousRevision, previousUpdatedAt, repoRoot);
const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
renameSync(temporaryPath, manifestPath);

const probeState = join(controllerHome, 'repositories', repoId, 'interactions', 'ios-agent-device', 'probe-state');
mkdirSync(probeState, { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_DEVICE_STATE_DIR: probeState,
  AGENT_DEVICE_PLATFORM: 'ios',
  AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '5000',
  AGENT_DEVICE_IOS_RUNNER_RETENTION_MS: '0',
  ...(teamId ? { AGENT_DEVICE_IOS_TEAM_ID: teamId } : {}),
  ...(runnerBundleId ? { AGENT_DEVICE_IOS_BUNDLE_ID: runnerBundleId } : {}),
  ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}),
};
const listed = spawnSync(executable, ['devices', '--platform', 'ios', '--json'], {
  cwd: repoRoot,
  env,
  encoding: 'utf8',
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
});
const listedJson = listed.status === 0 ? parseAgentDeviceJson(String(listed.stdout ?? '')) : undefined;
const listedData = listedJson?.data && typeof listedJson.data === 'object'
  ? listedJson.data as Record<string, unknown>
  : {};
const entries = (Array.isArray(listedData.devices) ? listedData.devices : [])
  .filter((entry): entry is AgentDeviceEntry => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
  .map((entry) => ({
    platform: String(entry.platform ?? ''),
    appleOs: typeof entry.appleOs === 'string' ? entry.appleOs : undefined,
    id: String(entry.id ?? ''),
    name: String(entry.name ?? ''),
    kind: String(entry.kind ?? ''),
    target: typeof entry.target === 'string' ? entry.target : undefined,
    booted: entry.booted === true,
  }))
  .filter((entry) => entry.platform === 'ios' && entry.id && entry.name);
const selected = deviceSelector
  ? entries.filter((entry) => entry.id === deviceSelector || entry.name === deviceSelector)
  : [];
if (deviceSelector && selected.length !== 1) {
  fail(`Expected exactly one agent-device iOS target for ${deviceSelector}; found ${selected.length}.`);
}

let doctor: Record<string, unknown> | undefined;
if (doctorApp) {
  if (!deviceSelector || selected.length !== 1) fail('--doctor-app requires one exact --device selector.');
  const result = spawnSync(executable, [
    'doctor', '--platform', 'ios', '--device', selected[0]!.id, '--app', doctorApp, '--json',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 4 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  doctor = result.status === 0
    ? parseAgentDeviceJson(String(result.stdout ?? ''))
    : {
        success: false,
        exitCode: result.status,
        stderr: String(result.stderr ?? '').slice(0, 8_000),
      };
}

let prepare: Record<string, unknown> | undefined;
if (hasFlag('--prepare-runner')) {
  if (!deviceSelector || selected.length !== 1) fail('--prepare-runner requires one exact --device selector.');
  prepare = await executeIosPluginAction({
    controllerHome,
    repoId,
    repoRoot,
    pluginId: 'ios',
    actionId: 'agent_device_prepare',
    requestId: `refresh-ios-prepare-${Date.now()}`,
    args: { device: selected[0]!.id, team_id: teamId, runner_bundle_id: runnerBundleId, developer_dir: developerDir },
    origin: { surface: 'local-ui', actor: 'refresh-ios-physical-runtime' },
  });
}

let jdSearch: Record<string, unknown> | undefined;
if (jdQuery) {
  if (!deviceSelector || selected.length !== 1) fail('--jd-query requires one exact --device selector.');
  jdSearch = await executeIosPluginAction({
    controllerHome,
    repoId,
    repoRoot,
    pluginId: 'ios',
    actionId: 'agent_device_jd_search',
    requestId: `refresh-ios-jd-search-${Date.now()}`,
    args: {
      device: selected[0]!.id,
      query: jdQuery,
      team_id: teamId,
      runner_bundle_id: runnerBundleId,
      developer_dir: developerDir,
    },
    origin: { surface: 'local-ui', actor: 'refresh-ios-physical-runtime' },
  });
}

console.log(JSON.stringify({
  manifest: {
    path: manifestPath,
    revision: manifest.revision,
    physicalActions: manifest.actions
      .filter((action) => action.actionId.startsWith('physical_device_'))
      .map((action) => action.actionId),
    agentDeviceActions: manifest.actions
      .filter((action) => action.actionId.startsWith('agent_device_'))
      .map((action) => action.actionId),
    agentDeviceCapabilities: manifest.capabilities
      .filter((capability) => capability.capabilityId.startsWith('ios-agent-device-'))
      .map((capability) => capability.capabilityId),
    physicalDevice: manifest.health.details?.physicalDevice,
  },
  agentDevice: {
    executable,
    listSuccess: listed.status === 0,
    exitCode: listed.status,
    stderr: listed.status === 0 ? undefined : String(listed.stderr ?? '').slice(0, 8_000),
    devices: entries,
    selected: selected[0],
    physicalListed: entries.some((entry) => entry.kind !== 'simulator'),
    prepare,
    jdSearch,
    doctor: hasFlag('--print-doctor') ? doctor : doctor ? {
      success: doctor.success !== false,
      dataKeys: doctor.data && typeof doctor.data === 'object' ? Object.keys(doctor.data as Record<string, unknown>).slice(0, 20) : [],
      error: doctor.success === false ? doctor : undefined,
    } : undefined,
  },
}, null, 2));
