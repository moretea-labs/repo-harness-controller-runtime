import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import {
  isInteractionSessionActive,
  listInteractionSessions,
  patchInteractionSession,
  pruneInteractionSessions,
  readInteractionSession,
  writeInteractionSession,
  type InteractionSessionRecord,
} from './interaction-session';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
} from './types';

const PROVIDER = 'ios-device' as const;
const SESSION_EXPIRY_MS = 2 * 60 * 60_000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_EVENTS = 200;
const LOCAL_RUNNER_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SENSITIVE_SEMANTICS = /secure\s*text|securetextfield|password|passcode|verification|one[ -]?time|otp|2fa|验证码|校验码|短信码|生物识别|biometric|face\s?id|touch\s?id|支付|付款|购买|下单|提交订单|结算|checkout|payment|purchase|confirm\s+order|bank|card|cvv|身份证/i;

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  command: string[];
}

interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunnerHttpResult {
  ok: boolean;
  status: number;
  body?: unknown;
  text: string;
}

export interface IosPhysicalDeviceRuntimeHooks {
  platform(): NodeJS.Platform;
  now(): Date;
  runCommand(command: string, args: string[], options?: CommandOptions): CommandResult;
  requestJson(method: string, url: string, body?: unknown, timeoutMs?: number): Promise<RunnerHttpResult>;
}

const defaultHooks: IosPhysicalDeviceRuntimeHooks = {
  platform: () => process.platform,
  now: () => new Date(),
  runCommand: (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? result.error?.message ?? ''),
      command: [command, ...args],
    };
  },
  requestJson: async (method, url, body, timeoutMs = 30_000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
      return { ok: response.ok, status: response.status, body: parsed, text };
    } finally {
      clearTimeout(timer);
    }
  },
};

let hooks: IosPhysicalDeviceRuntimeHooks = { ...defaultHooks };

export function setIosPhysicalDeviceRuntimeHooksForTest(overrides: Partial<IosPhysicalDeviceRuntimeHooks>): void {
  hooks = { ...defaultHooks, ...overrides };
}

export function resetIosPhysicalDeviceRuntimeHooksForTest(): void {
  hooks = { ...defaultHooks };
}

interface PhysicalDevice {
  identifier: string;
  udid?: string;
  name: string;
  model?: string;
  productType?: string;
  osVersion?: string;
  osBuild?: string;
  pairingState?: string;
  tunnelState?: string;
  transportType?: string;
  bootState?: string;
  developerMode?: string;
  ddiServicesAvailable: boolean;
  screenshotAvailable: boolean;
  connected: boolean;
}

interface InstalledApp {
  name: string;
  bundleIdentifier: string;
  bundleVersion?: string;
  version?: string;
  removable?: boolean;
}

interface PhysicalEvent {
  at: string;
  type: string;
  details?: unknown;
}

interface PhysicalSessionState {
  schemaVersion: 1;
  interactionId: string;
  device: PhysicalDevice;
  bundleId: string;
  runner: {
    configured: boolean;
    endpoint?: string;
    ready: boolean;
    sessionId?: string;
    error?: string;
  };
  events: PhysicalEvent[];
}

function timestamp(): string {
  return hooks.now().toISOString();
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ios-device';
}

function controllerRoot(input: AssistantPluginActionExecutionInput): string {
  return repositoryControllerRoot(input.controllerHome, input.repoId);
}

function providerRoot(input: AssistantPluginActionExecutionInput): string {
  const path = join(controllerRoot(input), 'interactions', 'ios-physical-device');
  mkdirSync(path, { recursive: true });
  return path;
}

function statePath(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  return join(providerRoot(input), 'state', `${sanitize(interactionId)}.json`);
}

function artifactDir(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  const path = join(controllerRoot(input), 'artifacts', 'ios', 'physical-device', sanitize(interactionId));
  mkdirSync(path, { recursive: true });
  return path;
}

function readState(input: AssistantPluginActionExecutionInput, interactionId: string): PhysicalSessionState | undefined {
  const value = readJsonFile<PhysicalSessionState | undefined>(statePath(input, interactionId), undefined);
  return value?.schemaVersion === 1 && value.interactionId === interactionId ? value : undefined;
}

function writeState(input: AssistantPluginActionExecutionInput, state: PhysicalSessionState): PhysicalSessionState {
  writeJsonAtomic(statePath(input, state.interactionId), state);
  return state;
}

function redacted(value: unknown, key = ''): unknown {
  if (/^(text|value|password|passcode|token|authorization|cookie)$/i.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((entry) => redacted(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entry]) => [entryKey, redacted(entry, entryKey)]));
  }
  return value;
}

function bounded(value: unknown): unknown {
  const safe = redacted(value);
  const text = JSON.stringify(safe);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_JSON_BYTES) return safe;
  return {
    truncated: true,
    byteLength: bytes,
    preview: Buffer.from(text, 'utf8').subarray(0, MAX_JSON_BYTES).toString('utf8'),
  };
}

function appendEvent(
  input: AssistantPluginActionExecutionInput,
  interactionId: string,
  type: string,
  details?: unknown,
): PhysicalSessionState | undefined {
  const state = readState(input, interactionId);
  if (!state) return undefined;
  state.events.push({ at: timestamp(), type, details: redacted(details) });
  state.events = state.events.slice(-MAX_EVENTS);
  return writeState(input, state);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`, { retryable: false });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireBundleId(value: unknown): string {
  const bundleId = requireString(value, 'bundle_id');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId) || !bundleId.includes('.') || /^[a-z][a-z0-9+.-]*:\/\//i.test(bundleId)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'bundle_id must be an installed application bundle identifier, not a URL or deep link.', { retryable: false });
  }
  return bundleId;
}

function commandFailure(result: CommandResult, code: string, fallback: string): never {
  throw new AssistantPluginError(code, result.stderr.trim() || result.stdout.trim() || fallback, {
    retryable: false,
    details: {
      status: result.status,
      command: result.command,
      stdout: result.stdout.slice(0, 8_000),
      stderr: result.stderr.slice(0, 8_000),
    },
  });
}

function runCoreJson(
  input: AssistantPluginActionExecutionInput,
  args: string[],
  code: string,
  timeoutMs = 30_000,
): Record<string, unknown> {
  if (hooks.platform() !== 'darwin') {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Physical iOS device support requires macOS and Xcode CoreDevice.', { retryable: false });
  }
  const result = hooks.runCommand('xcrun', ['devicectl', ...args, '--json-output', '-'], {
    cwd: input.repoRoot,
    timeoutMs,
  });
  if (!result.ok) return commandFailure(result, code, 'CoreDevice command failed.');
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(result.stdout.trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // Structured error below.
  }
  const info = parsed?.info && typeof parsed.info === 'object' ? parsed.info as Record<string, unknown> : undefined;
  if (!parsed || info?.outcome === 'failure') return commandFailure(result, code, 'CoreDevice returned invalid JSON.');
  return parsed;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && String(value[key]).trim() ? String(value[key]).trim() : undefined;
}

function physicalDevices(input: AssistantPluginActionExecutionInput): PhysicalDevice[] {
  const response = runCoreJson(input, ['list', 'devices'], 'IOS_DEVICE_LIST_FAILED');
  const result = objectValue(response.result);
  const entries = Array.isArray(result.devices) ? result.devices : [];
  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => {
      const hardware = objectValue(entry.hardwareProperties);
      const device = objectValue(entry.deviceProperties);
      const connection = objectValue(entry.connectionProperties);
      const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
      const capabilityNames = capabilities.map((item) => stringField(objectValue(item), 'name')).filter(Boolean);
      const pairingState = stringField(connection, 'pairingState');
      const tunnelState = stringField(connection, 'tunnelState');
      const bootState = stringField(device, 'bootState');
      return {
        identifier: stringField(entry, 'identifier') ?? '',
        udid: stringField(hardware, 'udid'),
        name: stringField(device, 'name') ?? '',
        model: stringField(hardware, 'marketingName'),
        productType: stringField(hardware, 'productType'),
        osVersion: stringField(device, 'osVersionNumber'),
        osBuild: stringField(device, 'osBuildUpdate'),
        pairingState,
        tunnelState,
        transportType: stringField(connection, 'transportType'),
        bootState,
        developerMode: stringField(device, 'developerModeStatus'),
        ddiServicesAvailable: device.ddiServicesAvailable === true,
        screenshotAvailable: capabilityNames.includes('Capture Screenshot'),
        connected: pairingState === 'paired'
          && bootState !== 'shutdown'
          && (tunnelState === 'connected'
            || device.ddiServicesAvailable === true
            || capabilityNames.includes('Application Control')
            || capabilityNames.includes('Launch Application')
            || connection.transportType === 'usb'
            || connection.transportType === 'wired'),
        reality: stringField(hardware, 'reality'),
        platform: stringField(hardware, 'platform'),
      } as PhysicalDevice & { reality?: string; platform?: string };
    })
    .filter((entry) => entry.identifier && entry.name
      && (entry as PhysicalDevice & { reality?: string }).reality === 'physical'
      && (entry as PhysicalDevice & { platform?: string }).platform === 'iOS')
    .map(({ reality: _reality, platform: _platform, ...entry }) => entry);
}

function selectDevice(input: AssistantPluginActionExecutionInput, selectorValue: unknown): PhysicalDevice {
  const selector = requireString(selectorValue, 'device');
  const inventory = physicalDevices(input);
  const matches = inventory.filter((entry) => entry.identifier === selector || entry.udid === selector || entry.name === selector);
  if (matches.length === 0) {
    throw new AssistantPluginError('IOS_DEVICE_NOT_FOUND', 'No paired physical iPhone matches the exact device selector.', {
      retryable: false,
      details: { selector, available: inventory.map((entry) => ({ identifier: entry.identifier, name: entry.name, connected: entry.connected })) },
    });
  }
  if (matches.length !== 1) {
    throw new AssistantPluginError('IOS_DEVICE_AMBIGUOUS', 'The physical iPhone selection is ambiguous; provide the exact CoreDevice identifier or UDID.', {
      retryable: false,
      details: { selector, matches: matches.map((entry) => ({ identifier: entry.identifier, name: entry.name })) },
    });
  }
  const selected = matches[0]!;
  if (selected.pairingState !== 'paired') {
    throw new AssistantPluginError('IOS_DEVICE_NOT_PAIRED', 'The selected iPhone is not paired with this Mac.', { retryable: false, details: { device: selected } });
  }
  return selected;
}

function installedApps(
  input: AssistantPluginActionExecutionInput,
  device: PhysicalDevice,
  bundleId: string,
): InstalledApp[] {
  let response: Record<string, unknown>;
  try {
    response = runCoreJson(input, [
      'device', 'info', 'apps', '--device', device.identifier,
      '--include-all-apps', '--bundle-id', bundleId,
    ], 'IOS_DEVICE_APPS_FAILED', 60_000);
  } catch (error) {
    if (!device.connected) {
      throw new AssistantPluginError('IOS_DEVICE_UNAVAILABLE', 'The selected iPhone is paired but its CoreDevice connection is currently unavailable. Unlock the phone and restore its USB or local-network connection, then retry.', {
        retryable: true,
        details: { device: { identifier: device.identifier, name: device.name, pairingState: device.pairingState, tunnelState: device.tunnelState, transportType: device.transportType } },
      });
    }
    throw error;
  }
  const result = objectValue(response.result);
  const entries = Array.isArray(result.apps) ? result.apps : [];
  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => ({
      name: stringField(entry, 'name') ?? '',
      bundleIdentifier: stringField(entry, 'bundleIdentifier') ?? '',
      bundleVersion: stringField(entry, 'bundleVersion'),
      version: stringField(entry, 'version'),
      removable: typeof entry.removable === 'boolean' ? entry.removable : undefined,
    }))
    .filter((entry) => entry.bundleIdentifier === bundleId);
}

function configuredRunner(): { configured: boolean; endpoint?: string; error?: string } {
  const raw = process.env.REPO_HARNESS_IOS_DEVICE_RUNNER_URL?.trim();
  if (!raw) return { configured: false, error: 'Set REPO_HARNESS_IOS_DEVICE_RUNNER_URL to a trusted localhost WDA-compatible endpoint.' };
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' || !LOCAL_RUNNER_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
      return { configured: false, error: 'The iOS UI runner URL must be an unauthenticated localhost HTTP endpoint.' };
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    parsed.search = '';
    parsed.hash = '';
    return { configured: true, endpoint: parsed.toString().replace(/\/$/, '') };
  } catch {
    return { configured: false, error: 'REPO_HARNESS_IOS_DEVICE_RUNNER_URL is not a valid URL.' };
  }
}

function runnerUrl(endpoint: string, path: string): string {
  return `${endpoint}${path.startsWith('/') ? path : `/${path}`}`;
}

function responseValue(body: unknown): unknown {
  const record = objectValue(body);
  return 'value' in record ? record.value : body;
}

async function runnerRequest(
  method: string,
  endpoint: string,
  path: string,
  body: unknown,
  code: string,
  sensitive = false,
): Promise<unknown> {
  let response: RunnerHttpResult;
  try {
    response = await hooks.requestJson(method, runnerUrl(endpoint, path), body, 30_000);
  } catch (error) {
    const normalized = toAssistantPluginError(error, {
      code,
      message: 'The local iOS UI runner could not be reached.',
      retryable: true,
    });
    throw new AssistantPluginError(normalized.code, normalized.message, {
      retryable: normalized.retryable,
      details: sensitive ? { endpoint, response: '<redacted>' } : { endpoint },
    });
  }
  if (!response.ok) {
    throw new AssistantPluginError(code, sensitive ? 'The local iOS UI runner rejected a sensitive-input action.' : `The local iOS UI runner returned HTTP ${response.status}.`, {
      retryable: response.status >= 500,
      details: sensitive ? { status: response.status, response: '<redacted>' } : { status: response.status, response: bounded(response.body ?? response.text) },
    });
  }
  return responseValue(response.body);
}

async function probeRunner(): Promise<{ configured: boolean; endpoint?: string; ready: boolean; error?: string; status?: unknown }> {
  const configured = configuredRunner();
  if (!configured.configured || !configured.endpoint) return { ...configured, ready: false };
  try {
    const status = await runnerRequest('GET', configured.endpoint, '/status', undefined, 'IOS_DEVICE_UI_RUNNER_UNAVAILABLE');
    const record = objectValue(status);
    return {
      configured: true,
      endpoint: configured.endpoint,
      ready: record.ready !== false,
      status: bounded(status),
    };
  } catch (error) {
    return {
      configured: true,
      endpoint: configured.endpoint,
      ready: false,
      error: toAssistantPluginError(error, {
        code: 'IOS_DEVICE_UI_RUNNER_UNAVAILABLE',
        message: 'The local iOS UI runner is unavailable.',
        retryable: true,
      }).message,
    };
  }
}

async function createRunnerSession(endpoint: string, bundleId: string): Promise<string> {
  const value = await runnerRequest('POST', endpoint, '/session', {
    capabilities: { alwaysMatch: { bundleId } },
    desiredCapabilities: { bundleId },
  }, 'IOS_DEVICE_UI_SESSION_FAILED');
  const record = objectValue(value);
  const sessionId = stringField(record, 'sessionId') ?? stringField(objectValue(objectValue(value).capabilities), 'sessionId');
  if (!sessionId) {
    throw new AssistantPluginError('IOS_DEVICE_UI_SESSION_FAILED', 'The UI runner did not return a WebDriver session id.', { retryable: false });
  }
  return sessionId;
}

async function closeRunner(state: PhysicalSessionState): Promise<boolean> {
  if (!state.runner.endpoint || !state.runner.sessionId) return true;
  try {
    await runnerRequest('DELETE', state.runner.endpoint, `/session/${encodeURIComponent(state.runner.sessionId)}`, undefined, 'IOS_DEVICE_UI_CLOSE_FAILED');
    return true;
  } catch {
    return false;
  }
}

function requireRecord(input: AssistantPluginActionExecutionInput, allowTerminal = false): { record: InteractionSessionRecord; state: PhysicalSessionState } {
  const interactionId = requireString(input.args.interaction_id, 'interaction_id');
  const record = readInteractionSession(input.repoRoot, PROVIDER, interactionId);
  const state = readState(input, interactionId);
  if (!record || !state) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unknown physical iOS interaction: ${interactionId}`, { retryable: false });
  }
  if (!isInteractionSessionActive(record.status) && !allowTerminal) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Physical iOS interaction is ${record.status}.`, {
      retryable: false,
      details: { interactionId, status: record.status },
    });
  }
  if (isInteractionSessionActive(record.status) && hooks.now().getTime() >= Date.parse(record.expiresAt)) {
    patchInteractionSession(input.repoRoot, PROVIDER, interactionId, {
      status: 'failed',
      error: { code: 'IOS_DEVICE_SESSION_EXPIRED', message: 'The physical iOS interaction expired.' },
    });
    throw new AssistantPluginError('IOS_DEVICE_SESSION_EXPIRED', 'The physical iOS interaction expired; open a new session.', { retryable: false });
  }
  return { record, state };
}

function requireRunner(state: PhysicalSessionState): { endpoint: string; sessionId: string } {
  if (!state.runner.ready || !state.runner.endpoint || !state.runner.sessionId) {
    throw new AssistantPluginError('IOS_DEVICE_UI_RUNNER_UNAVAILABLE', state.runner.error ?? 'No signed WDA-compatible UI runner is attached to this physical-device session.', {
      retryable: true,
      details: {
        configured: state.runner.configured,
        prerequisites: [
          'Enable Developer Mode and trust/pair the iPhone with Xcode.',
          'Build and run a correctly signed WebDriverAgent-compatible runner for this device.',
          'Forward its HTTP endpoint to localhost and set REPO_HARNESS_IOS_DEVICE_RUNNER_URL.',
        ],
      },
    });
  }
  return { endpoint: state.runner.endpoint, sessionId: state.runner.sessionId };
}

function rejectSensitiveSemantic(value: string, action: string): void {
  if (SENSITIVE_SEMANTICS.test(value)) {
    throw new AssistantPluginError('IOS_DEVICE_HUMAN_ACTION_REQUIRED', `${action} targets a credential, verification, biometric, purchase, checkout, or payment flow and must be completed manually.`, {
      retryable: false,
      details: { humanHandoffRequired: true },
    });
  }
}

function locator(target: string): { using: string; value: string } {
  if (target.startsWith('xpath:')) return { using: 'xpath', value: target.slice(6) };
  if (target.startsWith('id:')) return { using: 'accessibility id', value: target.slice(3) };
  return { using: 'accessibility id', value: target };
}

async function elementId(endpoint: string, sessionId: string, target: string): Promise<string> {
  const value = await runnerRequest('POST', endpoint, `/session/${encodeURIComponent(sessionId)}/element`, locator(target), 'IOS_DEVICE_ELEMENT_NOT_FOUND');
  const record = objectValue(value);
  const id = stringField(record, 'element-6066-11e4-a52e-4f735466cecf') ?? stringField(record, 'ELEMENT');
  if (!id) throw new AssistantPluginError('IOS_DEVICE_ELEMENT_NOT_FOUND', 'The UI runner did not return an element id.', { retryable: false });
  return id;
}

async function inspectElementSemantics(
  endpoint: string,
  sessionId: string,
  elementIdValue: string,
  target: string,
  action: string,
): Promise<void> {
  const attributes = ['type', 'name', 'label', 'placeholderValue'];
  const values: string[] = [target];
  for (const attribute of attributes) {
    const value = await runnerRequest(
      'GET',
      endpoint,
      `/session/${encodeURIComponent(sessionId)}/element/${encodeURIComponent(elementIdValue)}/attribute/${encodeURIComponent(attribute)}`,
      undefined,
      'IOS_DEVICE_ELEMENT_INSPECTION_FAILED',
    );
    if (typeof value === 'string') values.push(value);
  }
  rejectSensitiveSemantic(values.join(' '), action);
}

export function iosPhysicalDeviceStatus() {
  if (hooks.platform() !== 'darwin') {
    return {
      available: false,
      platform: hooks.platform(),
      coreDeviceReady: false,
      uiRunner: { ...configuredRunner(), ready: false },
      reason: 'Physical iOS device support requires macOS and Xcode.',
    };
  }
  const result = hooks.runCommand('xcrun', ['devicectl', '--version'], { timeoutMs: 5_000 });
  return {
    available: result.ok,
    platform: hooks.platform(),
    coreDeviceReady: result.ok,
    devicectlVersion: result.ok ? result.stdout.trim() : undefined,
    uiRunner: { ...configuredRunner(), ready: false, readinessCheckedOnAction: true },
    reason: result.ok ? undefined : (result.stderr || result.stdout || 'xcrun devicectl is unavailable.'),
  };
}

export function isIosPhysicalDeviceAction(actionId: string): boolean {
  return actionId.startsWith('physical_device_');
}

export function iosPhysicalDeviceCapabilities(): AssistantPluginCapability[] {
  return [{
    capabilityId: 'ios-physical-device',
    title: 'Physical iOS Computer Use',
    description: 'Bounded CoreDevice discovery, installed-app launch and screenshot, with optional signed localhost WDA-compatible UI automation.',
    scopes: ['ios.discover', 'ios.device'],
    actions: iosPhysicalDeviceActions().map((action) => action.actionId),
  }];
}

export function iosPhysicalDeviceActions(): AssistantPluginActionDescriptor[] {
  const stateClaim = [{ resource: 'repo-state' as const, mode: 'write' as const }];
  const mutationClaims = [
    { resource: 'workspace' as const, mode: 'write' as const },
    { resource: 'repo-state' as const, mode: 'write' as const },
  ];
  const interactionProperty = { interaction_id: { type: 'string' } };
  return [
    {
      actionId: 'physical_device_status', title: 'Physical iOS device status',
      description: 'Report CoreDevice readiness and probe an explicitly configured localhost UI runner.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.discover'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'physical_device_list', title: 'List paired physical iPhones',
      description: 'List bounded CoreDevice metadata for paired physical iOS devices; serial numbers and ECIDs are omitted.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.discover'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'physical_device_apps', title: 'Find installed physical-device app',
      description: 'Verify one exact bundle identifier is installed on an exact paired iPhone without reading its data container.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: stateClaim,
      argumentsSchema: { type: 'object', properties: { device: { type: 'string' }, bundle_id: { type: 'string' } }, required: ['device', 'bundle_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_open', title: 'Open physical iOS app session',
      description: 'Launch one installed third-party app on an exact paired iPhone and create a bounded interaction session. URLs and deep links are rejected.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 2 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { device: { type: 'string' }, bundle_id: { type: 'string' }, relaunch: { type: 'boolean' } }, required: ['device', 'bundle_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_snapshot', title: 'Snapshot physical iOS UI',
      description: 'Read bounded UI source through the signed localhost runner. Fails closed when the runner is unavailable.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: stateClaim,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_press', title: 'Press physical iOS target',
      description: 'Press a non-sensitive accessibility target or coordinate through the signed runner. Purchase, payment, biometric and credential semantics are blocked.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, target: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, purpose: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_fill', title: 'Fill physical iOS target',
      description: 'Replace non-sensitive text through the signed runner. Text is redacted and passwords, codes, biometrics, checkout and payment targets are blocked.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, target: { type: 'string' }, text: { type: 'string' } }, required: ['interaction_id', 'target', 'text'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_scroll', title: 'Scroll physical iOS session',
      description: 'Scroll an active physical-device UI session through the signed runner.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] }, amount: { type: 'number' } }, required: ['interaction_id', 'direction'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_screenshot', title: 'Capture physical iOS screenshot',
      description: 'Capture the exact paired iPhone display through CoreDevice into Controller-owned bounded artifact storage.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, label: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_events', title: 'Read physical iOS events',
      description: 'Read bounded, redacted provider events without input text or credentials.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: stateClaim,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, limit: { type: 'number' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'physical_device_close', title: 'Close physical iOS session',
      description: 'Close the optional UI-runner session and release Controller ownership without shutting down or modifying the iPhone.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.device'], resourceClaims: mutationClaims,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty }, required: ['interaction_id'], additionalProperties: false },
    },
  ];
}

export async function executeIosPhysicalDeviceAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  if (input.actionId === 'physical_device_status') {
    return { provider: 'coredevice', ...iosPhysicalDeviceStatus(), uiRunner: await probeRunner() };
  }
  const status = iosPhysicalDeviceStatus();
  if (!status.coreDeviceReady) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', status.reason ?? 'Xcode CoreDevice is unavailable.', { retryable: false, details: status });
  }
  if (input.actionId === 'physical_device_list') {
    return { provider: 'coredevice', devices: physicalDevices(input) };
  }
  if (input.actionId === 'physical_device_apps') {
    const selected = selectDevice(input, input.args.device);
    const bundleId = requireBundleId(input.args.bundle_id);
    return { provider: 'coredevice', device: selected, apps: installedApps(input, selected, bundleId) };
  }
  if (input.actionId === 'physical_device_open') {
    const selected = selectDevice(input, input.args.device);
    const bundleId = requireBundleId(input.args.bundle_id);
    const apps = installedApps(input, selected, bundleId);
    if (apps.length !== 1) {
      throw new AssistantPluginError('IOS_DEVICE_APP_NOT_INSTALLED', `The app ${bundleId} is not installed on the selected iPhone.`, { retryable: false });
    }
    const conflict = listInteractionSessions(input.repoRoot, PROVIDER).find((entry) =>
      isInteractionSessionActive(entry.status) && entry.targetId === selected.identifier);
    if (conflict) {
      throw new AssistantPluginError('PLUGIN_RESOURCE_BUSY', 'The selected iPhone already has an active repo-harness interaction.', {
        retryable: true,
        details: { interactionId: conflict.interactionId, targetId: conflict.targetId },
      });
    }
    pruneInteractionSessions(input.repoRoot, PROVIDER, 100);
    const interactionId = `ios_device_${randomUUID()}`;
    const createdAt = timestamp();
    const record: InteractionSessionRecord = {
      schemaVersion: 1,
      interactionId,
      provider: PROVIDER,
      sessionId: `repo-harness-${sanitize(interactionId).slice(-40)}`,
      targetId: selected.identifier,
      status: 'starting',
      reason: 'ios_physical_device_automation',
      instructions: bundleId,
      owner: { repoId: input.repoId, requestId: input.requestId, jobId: input.jobId },
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(hooks.now().getTime() + SESSION_EXPIRY_MS).toISOString(),
    };
    writeInteractionSession(input.repoRoot, record);
    const runnerProbe = await probeRunner();
    const state: PhysicalSessionState = {
      schemaVersion: 1,
      interactionId,
      device: selected,
      bundleId,
      runner: {
        configured: runnerProbe.configured,
        endpoint: runnerProbe.endpoint,
        ready: false,
        error: runnerProbe.error,
      },
      events: [{ at: createdAt, type: 'session_created', details: { bundleId, deviceIdentifier: selected.identifier } }],
    };
    writeState(input, state);
    try {
      const args = ['device', 'process', 'launch', '--device', selected.identifier];
      if (input.args.relaunch === true) args.push('--terminate-existing');
      args.push(bundleId);
      const launch = runCoreJson(input, args, 'IOS_DEVICE_LAUNCH_FAILED', 60_000);
      appendEvent(input, interactionId, 'app_launched', { bundleId, relaunch: input.args.relaunch === true });
      if (runnerProbe.ready && runnerProbe.endpoint) {
        try {
          state.runner.sessionId = await createRunnerSession(runnerProbe.endpoint, bundleId);
          state.runner.ready = true;
          state.runner.error = undefined;
          writeState(input, state);
          appendEvent(input, interactionId, 'ui_runner_attached', { endpoint: runnerProbe.endpoint });
        } catch (error) {
          state.runner.ready = false;
          state.runner.error = toAssistantPluginError(error, {
            code: 'IOS_DEVICE_UI_SESSION_FAILED',
            message: 'The app launched, but the UI runner session could not be created.',
            retryable: true,
          }).message;
          writeState(input, state);
          appendEvent(input, interactionId, 'ui_runner_unavailable', { error: state.runner.error });
        }
      }
      const active = patchInteractionSession(input.repoRoot, PROVIDER, interactionId, { status: 'waiting_for_user' }) ?? record;
      return {
        provider: 'coredevice',
        interaction: active,
        device: selected,
        app: apps[0],
        launch: bounded(launch),
        uiAutomation: bounded(readState(input, interactionId)?.runner),
      };
    } catch (error) {
      const normalized = toAssistantPluginError(error, {
        code: 'IOS_DEVICE_OPEN_FAILED',
        message: 'The physical iOS app could not be opened.',
        retryable: false,
      });
      patchInteractionSession(input.repoRoot, PROVIDER, interactionId, {
        status: 'failed',
        error: { code: normalized.code, message: normalized.message },
      });
      appendEvent(input, interactionId, 'open_failed', { code: normalized.code, message: normalized.message });
      throw normalized;
    }
  }

  const { record, state } = requireRecord(input, input.actionId === 'physical_device_close');
  switch (input.actionId) {
    case 'physical_device_snapshot': {
      const runner = requireRunner(state);
      const value = await runnerRequest('GET', runner.endpoint, `/session/${encodeURIComponent(runner.sessionId)}/source`, undefined, 'IOS_DEVICE_SNAPSHOT_FAILED');
      appendEvent(input, record.interactionId, 'snapshot');
      return { provider: 'coredevice', interaction: record, source: bounded(value) };
    }
    case 'physical_device_press': {
      const runner = requireRunner(state);
      const target = optionalString(input.args.target);
      const hasPoint = typeof input.args.x === 'number' && typeof input.args.y === 'number';
      if (!target && !hasPoint) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'target or x/y is required.', { retryable: false });
      if (target) {
        rejectSensitiveSemantic(target, 'Press');
        const id = await elementId(runner.endpoint, runner.sessionId, target);
        await inspectElementSemantics(runner.endpoint, runner.sessionId, id, target, 'Press');
        await runnerRequest('POST', runner.endpoint, `/session/${encodeURIComponent(runner.sessionId)}/element/${encodeURIComponent(id)}/click`, {}, 'IOS_DEVICE_PRESS_FAILED');
        appendEvent(input, record.interactionId, 'press', { target });
      } else {
        const purpose = requireString(input.args.purpose, 'purpose');
        rejectSensitiveSemantic(purpose, 'Coordinate press');
        await runnerRequest('POST', runner.endpoint, `/session/${encodeURIComponent(runner.sessionId)}/wda/tap`, {
          x: Number(input.args.x), y: Number(input.args.y),
        }, 'IOS_DEVICE_PRESS_FAILED');
        appendEvent(input, record.interactionId, 'press_coordinate', { x: input.args.x, y: input.args.y, purpose });
      }
      return { provider: 'coredevice', interaction: record, success: true };
    }
    case 'physical_device_fill': {
      const runner = requireRunner(state);
      const target = requireString(input.args.target, 'target');
      rejectSensitiveSemantic(target, 'Fill');
      const text = typeof input.args.text === 'string' ? input.args.text : undefined;
      if (text === undefined) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'text is required.', { retryable: false });
      const id = await elementId(runner.endpoint, runner.sessionId, target);
      await inspectElementSemantics(runner.endpoint, runner.sessionId, id, target, 'Fill');
      await runnerRequest('POST', runner.endpoint, `/session/${encodeURIComponent(runner.sessionId)}/element/${encodeURIComponent(id)}/clear`, {}, 'IOS_DEVICE_FILL_FAILED', true);
      await runnerRequest('POST', runner.endpoint, `/session/${encodeURIComponent(runner.sessionId)}/element/${encodeURIComponent(id)}/value`, {
        text, value: Array.from(text),
      }, 'IOS_DEVICE_FILL_FAILED', true);
      appendEvent(input, record.interactionId, 'fill', { target, text: '<redacted>' });
      return { provider: 'coredevice', interaction: record, success: true, text: '<redacted>' };
    }
    case 'physical_device_scroll': {
      const runner = requireRunner(state);
      const direction = requireString(input.args.direction, 'direction');
      if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Unsupported scroll direction.', { retryable: false });
      }
      const sizeValue = await runnerRequest('GET', runner.endpoint, `/session/${encodeURIComponent(runner.sessionId)}/window/size`, undefined, 'IOS_DEVICE_SCROLL_FAILED');
      const size = objectValue(sizeValue);
      const width = Number(size.width ?? 0);
      const height = Number(size.height ?? 0);
      if (!(width > 0 && height > 0)) throw new AssistantPluginError('IOS_DEVICE_SCROLL_FAILED', 'The UI runner returned an invalid window size.', { retryable: false });
      const amount = Math.max(20, Math.min(80, typeof input.args.amount === 'number' ? Math.trunc(input.args.amount) : 60)) / 100;
      let fromX = width / 2; let toX = width / 2; let fromY = height / 2; let toY = height / 2;
      if (direction === 'down' || direction === 'bottom') { fromY = height * 0.8; toY = height * (0.8 - amount); }
      if (direction === 'up' || direction === 'top') { fromY = height * 0.2; toY = height * (0.2 + amount); }
      if (direction === 'right') { fromX = width * 0.8; toX = width * (0.8 - amount); }
      if (direction === 'left') { fromX = width * 0.2; toX = width * (0.2 + amount); }
      await runnerRequest('POST', runner.endpoint, `/session/${encodeURIComponent(runner.sessionId)}/wda/dragfromtoforduration`, {
        fromX, fromY, toX, toY, duration: 0.25,
      }, 'IOS_DEVICE_SCROLL_FAILED');
      appendEvent(input, record.interactionId, 'scroll', { direction, amount });
      return { provider: 'coredevice', interaction: record, success: true };
    }
    case 'physical_device_screenshot': {
      const label = sanitize(optionalString(input.args.label) ?? 'screenshot');
      const path = join(artifactDir(input, record.interactionId), `${label}-${hooks.now().getTime()}.png`);
      const result = runCoreJson(input, [
        'device', 'capture', 'screenshot', '--device', state.device.identifier, '--destination', path,
      ], 'IOS_DEVICE_SCREENSHOT_FAILED', 60_000);
      if (!existsSync(path)) {
        throw new AssistantPluginError('IOS_DEVICE_SCREENSHOT_MISSING', 'CoreDevice succeeded without creating the requested screenshot.', { retryable: false });
      }
      appendEvent(input, record.interactionId, 'screenshot', { label });
      return {
        provider: 'coredevice', interaction: record, result: bounded(result),
        artifactCandidates: [{ kind: 'ios_physical_device_screenshot', mediaType: 'image/png', path }],
      };
    }
    case 'physical_device_events': {
      const limit = Math.max(1, Math.min(MAX_EVENTS, typeof input.args.limit === 'number' ? Math.trunc(input.args.limit) : 50));
      return { provider: 'coredevice', interaction: record, events: bounded(state.events.slice(-limit)) };
    }
    case 'physical_device_close': {
      const wasActive = isInteractionSessionActive(record.status);
      const runnerNeedsCleanup = Boolean(state.runner.endpoint && state.runner.sessionId);
      if (!wasActive && !runnerNeedsCleanup) return { provider: 'coredevice', interaction: record, alreadyClosed: true };
      if (wasActive) patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, { status: 'closing' });
      const closed = await closeRunner(state);
      if (!closed) {
        patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, {
          status: 'closing',
          error: { code: 'IOS_DEVICE_UI_CLOSE_FAILED', message: 'The UI runner session could not be closed; ownership remains fenced.' },
        });
        throw new AssistantPluginError('IOS_DEVICE_UI_CLOSE_FAILED', 'The UI runner session could not be closed; retry physical_device_close.', { retryable: true });
      }
      state.runner.ready = false;
      state.runner.sessionId = undefined;
      writeState(input, state);
      appendEvent(input, record.interactionId, 'session_closed');
      if (!wasActive) {
        return { provider: 'coredevice', interaction: record, alreadyClosed: true, runnerCleaned: runnerNeedsCleanup, deviceUnmodified: true };
      }
      const finalRecord = patchInteractionSession(input.repoRoot, PROVIDER, record.interactionId, { status: 'closed', error: undefined }) ?? record;
      return { provider: 'coredevice', interaction: finalRecord, deviceUnmodified: true };
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `ios/${input.actionId} is not supported.`, { retryable: false });
  }
}
