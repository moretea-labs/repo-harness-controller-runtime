import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { isAbsolute, join } from 'path';
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
  type InteractionProvider,
  type InteractionSessionRecord,
} from './interaction-session';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
} from './types';

export const IOS_AGENT_DEVICE_VERSION = '0.19.3';
const SIMULATOR_PROVIDER = 'ios-simulator' as const;
const DEVICE_PROVIDER = 'ios-device' as const;
const PROVIDERS: InteractionProvider[] = [SIMULATOR_PROVIDER, DEVICE_PROVIDER];
const STATUS_TTL_MS = 60_000;
const MAX_JSON_BYTES = 64 * 1024;
const SESSION_EXPIRY_MS = 2 * 60 * 60_000;
const JD_BUNDLE_ID = 'com.360buy.jdmobile';
const MAX_JD_QUERY_LENGTH = 120;
const MAX_BATCH_STEPS = 20;
const DEFAULT_AGENT_DEVICE_IDLE_MS = '300000';
const BATCH_KINDS = ['snapshot', 'press', 'fill', 'scroll', 'keyboard', 'wait', 'back'] as const;
type AgentDeviceBatchKind = typeof BATCH_KINDS[number];

interface AgentDeviceBatchStep {
  kind: AgentDeviceBatchKind;
  input: Record<string, unknown>;
}

interface PreparedAgentDeviceBatch {
  nativeSteps: Array<{ command: AgentDeviceBatchKind; input: Record<string, unknown> }>;
  redactions: string[];
}
const SENSITIVE_SEMANTICS = /secure\s*text|securetextfield|password|passcode|verification|one[ -]?time|otp|2fa|密码|口令|验证码|校验码|短信码|生物识别|biometric|face\s?id|touch\s?id|支付|付款|购买|下单|提交订单|确认订单|结算|checkout|payment|purchase|confirm\s+order|bank|card|cvv|身份证/i;

interface AgentDeviceSigningConfig {
  schemaVersion: 1;
  teamId?: string;
  bundleId?: string;
  developerDir?: string;
}

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

export interface IosAgentDeviceRuntimeHooks {
  platform(): NodeJS.Platform;
  now(): Date;
  runCommand(command: string, args: string[], options?: CommandOptions): CommandResult;
}

const defaultHooks: IosAgentDeviceRuntimeHooks = {
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
};

let hooks: IosAgentDeviceRuntimeHooks = { ...defaultHooks };
let statusCache: { expiresAt: number; value: ReturnType<typeof probeStatus> } | undefined;

export function setIosAgentDeviceRuntimeHooksForTest(overrides: Partial<IosAgentDeviceRuntimeHooks>): void {
  hooks = { ...defaultHooks, ...overrides };
  statusCache = undefined;
}

export function resetIosAgentDeviceRuntimeHooksForTest(): void {
  hooks = { ...defaultHooks };
  statusCache = undefined;
}

function executable(): string {
  return process.env.REPO_HARNESS_AGENT_DEVICE_EXECUTABLE?.trim() || 'agent-device';
}

function timestamp(): string {
  return hooks.now().toISOString();
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ios-agent-device';
}

function probeStatus() {
  if (hooks.platform() !== 'darwin') {
    return {
      available: false,
      expectedVersion: IOS_AGENT_DEVICE_VERSION,
      platform: hooks.platform(),
      reason: 'agent-device iOS support requires macOS.',
    };
  }
  const result = hooks.runCommand(executable(), ['--version'], { timeoutMs: 3_000 });
  const detectedVersion = result.ok ? result.stdout.trim() : undefined;
  return {
    available: result.ok && detectedVersion === IOS_AGENT_DEVICE_VERSION,
    expectedVersion: IOS_AGENT_DEVICE_VERSION,
    detectedVersion,
    executable: executable(),
    platform: hooks.platform(),
    reason: !result.ok
      ? (result.stderr || result.stdout || 'agent-device is not installed.')
      : detectedVersion !== IOS_AGENT_DEVICE_VERSION
        ? `Expected agent-device ${IOS_AGENT_DEVICE_VERSION}, found ${detectedVersion || 'unknown'}.`
        : undefined,
  };
}

export function iosAgentDeviceStatus(options: { forceRefresh?: boolean } = {}) {
  const nowMs = hooks.now().getTime();
  if (!options.forceRefresh && statusCache && statusCache.expiresAt > nowMs) return statusCache.value;
  const value = probeStatus();
  statusCache = { expiresAt: nowMs + STATUS_TTL_MS, value };
  return value;
}

function requireDependency(): ReturnType<typeof probeStatus> {
  const status = iosAgentDeviceStatus();
  if (!status.available) {
    throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', status.reason ?? 'agent-device is unavailable.', {
      retryable: false,
      details: status,
    });
  }
  return status;
}

function controllerRoot(input: AssistantPluginActionExecutionInput): string {
  return repositoryControllerRoot(input.controllerHome, input.repoId);
}

function interactionRoot(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  return join(controllerRoot(input), 'interactions', 'ios-agent-device', sanitize(interactionId));
}

function stateDir(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  const path = join(interactionRoot(input, interactionId), 'state');
  mkdirSync(path, { recursive: true });
  return path;
}

function signingConfigPath(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  return join(interactionRoot(input, interactionId), 'signing.json');
}

function readSigningConfig(
  input: AssistantPluginActionExecutionInput,
  interactionId: string,
): AgentDeviceSigningConfig | undefined {
  const value = readJsonFile<AgentDeviceSigningConfig | undefined>(signingConfigPath(input, interactionId), undefined);
  return value?.schemaVersion === 1 ? value : undefined;
}

function writeSigningConfig(
  input: AssistantPluginActionExecutionInput,
  interactionId: string,
  config: AgentDeviceSigningConfig,
): void {
  writeJsonAtomic(signingConfigPath(input, interactionId), config);
}

function signingEnv(config?: AgentDeviceSigningConfig): NodeJS.ProcessEnv {
  return {
    ...(config?.teamId ? { AGENT_DEVICE_IOS_TEAM_ID: config.teamId } : {}),
    ...(config?.bundleId ? { AGENT_DEVICE_IOS_BUNDLE_ID: config.bundleId } : {}),
    ...(config?.developerDir ? { DEVELOPER_DIR: config.developerDir } : {}),
  };
}

function artifactDir(input: AssistantPluginActionExecutionInput, interactionId: string): string {
  const path = join(controllerRoot(input), 'artifacts', 'ios', 'agent-device', sanitize(interactionId));
  mkdirSync(path, { recursive: true });
  return path;
}

function sessionEnv(input: AssistantPluginActionExecutionInput, record: InteractionSessionRecord): NodeJS.ProcessEnv {
  const config = readSigningConfig(input, record.interactionId);
  return {
    ...process.env,
    ...signingEnv(config),
    AGENT_DEVICE_STATE_DIR: stateDir(input, record.interactionId),
    AGENT_DEVICE_SESSION: record.sessionId,
    AGENT_DEVICE_PLATFORM: 'ios',
    AGENT_DEVICE_SESSION_LOCK: 'reject',
    // Keep the per-interaction daemon and a healthy XCTest runner warm between
    // commands. The previous five-second/zero-retention policy forced repeated
    // cold starts during ordinary multi-step device workflows.
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS:
      process.env.REPO_HARNESS_AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
    AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS:
      process.env.REPO_HARNESS_AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
  };
}

function probeEnv(input: AssistantPluginActionExecutionInput, config?: AgentDeviceSigningConfig): NodeJS.ProcessEnv {
  const path = join(controllerRoot(input), 'interactions', 'ios-agent-device', 'probe-state');
  mkdirSync(path, { recursive: true });
  return {
    ...process.env,
    ...signingEnv(config),
    AGENT_DEVICE_STATE_DIR: path,
    AGENT_DEVICE_PLATFORM: 'ios',
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS:
      process.env.REPO_HARNESS_AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
    AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS:
      process.env.REPO_HARNESS_AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS?.trim() || DEFAULT_AGENT_DEVICE_IDLE_MS,
  };
}

function bounded(value: unknown): unknown {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_JSON_BYTES) return value;
  return {
    truncated: true,
    byteLength: bytes,
    preview: Buffer.from(text, 'utf8').subarray(0, MAX_JSON_BYTES).toString('utf8'),
  };
}

function redactExactText(value: unknown, text: string): unknown {
  if (!text) return value;
  if (typeof value === 'string') return value.split(text).join('<redacted>');
  if (Array.isArray(value)) return value.map((entry) => redactExactText(entry, text));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, redactExactText(entry, text)]));
  }
  return value;
}

function redactEventEvidence(value: unknown, key = ''): unknown {
  if (/^(args|arguments|input|payload|text|value)$/i.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((entry) => redactEventEvidence(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entry]) => [entryKey, redactEventEvidence(entry, entryKey)]));
  }
  return value;
}

function redactedCommand(command: string[]): string[] {
  if (command[1] !== 'fill') return command;
  const copy = [...command];
  if (copy.length > 3) copy[3] = '<redacted>';
  return copy;
}

function parseJsonResult(result: CommandResult, failureCode: string): Record<string, unknown> {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(result.stdout.trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // The structured failure below includes bounded raw diagnostics.
  }
  const success = result.ok && parsed?.success !== false;
  if (!success) {
    const sensitive = result.command[1] === 'fill';
    const message = sensitive
      ? 'agent-device fill failed.'
      : String(
        (parsed?.error && typeof parsed.error === 'object' && 'message' in parsed.error
          ? (parsed.error as { message?: unknown }).message
          : undefined)
        || result.stderr
        || result.stdout
        || 'agent-device command failed.',
      );
    throw new AssistantPluginError(failureCode, message, {
      retryable: false,
      details: {
        status: result.status,
        command: redactedCommand(result.command),
        stdout: sensitive ? '<redacted for fill>' : result.stdout.slice(0, 8_000),
        stderr: sensitive ? '<redacted for fill>' : result.stderr.slice(0, 8_000),
      },
    });
  }
  return parsed ?? { success: true, data: { stdout: result.stdout.trim() } };
}

function runJson(
  input: AssistantPluginActionExecutionInput,
  args: string[],
  options: {
    record?: InteractionSessionRecord;
    signing?: AgentDeviceSigningConfig;
    timeoutMs?: number;
    failureCode: string;
  },
): Record<string, unknown> {
  const result = hooks.runCommand(executable(), args, {
    cwd: input.repoRoot,
    timeoutMs: options.timeoutMs,
    env: options.record ? sessionEnv(input, options.record) : probeEnv(input, options.signing),
  });
  return parseJsonResult(result, options.failureCode);
}

interface AgentDeviceEntry {
  platform: string;
  appleOs?: string;
  id: string;
  name: string;
  kind: string;
  target?: string;
  booted: boolean;
}

function devices(input: AssistantPluginActionExecutionInput): AgentDeviceEntry[] {
  const response = runJson(input, ['devices', '--platform', 'ios', '--json'], {
    failureCode: 'AGENT_DEVICE_DEVICES_FAILED',
    timeoutMs: 30_000,
  });
  const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
  return (Array.isArray(data.devices) ? data.devices : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
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
}

function providerForDevice(device: AgentDeviceEntry): InteractionProvider {
  return device.kind === 'simulator' ? SIMULATOR_PROVIDER : DEVICE_PROVIDER;
}

function selectTarget(input: AssistantPluginActionExecutionInput, selector?: string): AgentDeviceEntry {
  const inventory = devices(input);
  const exact = selector
    ? inventory.filter((entry) => entry.id === selector || entry.name === selector)
    : inventory.filter((entry) => entry.booted && entry.kind === 'simulator');
  const ready = exact.filter((entry) => entry.booted && (entry.kind === 'simulator' || entry.kind === 'device'));
  if (ready.length === 0) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', selector
      ? 'Select one connected physical iPhone or already-booted iOS Simulator by exact name or UDID.'
      : 'Select one already-booted iOS Simulator, or provide an exact physical iPhone name or UDID.', {
      retryable: false,
      details: {
        selector,
        matches: exact.map((entry) => ({ id: entry.id, name: entry.name, kind: entry.kind, booted: entry.booted })),
      },
    });
  }
  if (ready.length !== 1) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'The iOS target selection is ambiguous; provide the exact UDID.', {
      retryable: false,
      details: { selector, matches: ready.map((entry) => ({ id: entry.id, name: entry.name, kind: entry.kind })) },
    });
  }
  return ready[0]!;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${name} is required.`, { retryable: false });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function signingFromArgs(args: Record<string, unknown>): AgentDeviceSigningConfig {
  const developerDir = optionalString(args.developer_dir);
  if (developerDir && (!isAbsolute(developerDir) || !developerDir.endsWith('/Contents/Developer') || !existsSync(developerDir))) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'developer_dir must be an existing absolute Xcode Contents/Developer directory.', { retryable: false });
  }
  return {
    schemaVersion: 1,
    teamId: optionalString(args.team_id),
    bundleId: optionalString(args.runner_bundle_id),
    developerDir,
  };
}

function isAgentDeviceInteraction(record: InteractionSessionRecord): boolean {
  return record.interactionId.startsWith('ios_agent_device_')
    && (record.reason === 'ios_simulator_automation' || record.reason === 'ios_physical_device_automation');
}

function readAgentDeviceInteraction(repoRoot: string, interactionId: string): InteractionSessionRecord | undefined {
  for (const provider of PROVIDERS) {
    const record = readInteractionSession(repoRoot, provider, interactionId);
    if (record && isAgentDeviceInteraction(record)) return record;
  }
  return undefined;
}

function listAgentDeviceInteractions(repoRoot: string): InteractionSessionRecord[] {
  return PROVIDERS.flatMap((provider) => listInteractionSessions(repoRoot, provider))
    .filter(isAgentDeviceInteraction);
}

function listAllIosInteractions(repoRoot: string): InteractionSessionRecord[] {
  return PROVIDERS.flatMap((provider) => listInteractionSessions(repoRoot, provider));
}

function requireRecord(input: AssistantPluginActionExecutionInput, allowTerminal = false): InteractionSessionRecord {
  const interactionId = requireString(input.args.interaction_id, 'interaction_id');
  const record = readAgentDeviceInteraction(input.repoRoot, interactionId);
  if (!record) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unknown iOS agent-device interaction: ${interactionId}`, { retryable: false });
  }
  if (!isInteractionSessionActive(record.status)) {
    if (allowTerminal) return record;
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `iOS agent-device interaction is ${record.status}.`, {
      retryable: false,
      details: { interactionId, status: record.status },
    });
  }
  if (hooks.now().getTime() >= Date.parse(record.expiresAt)) {
    const closed = bestEffortClose(input, record);
    patchInteractionSession(input.repoRoot, record.provider, interactionId, closed
      ? {
        status: 'failed',
        error: { code: 'AGENT_DEVICE_SESSION_EXPIRED', message: 'The agent-device session expired and was closed.' },
      }
      : {
        status: 'closing',
        error: { code: 'AGENT_DEVICE_CLEANUP_FAILED', message: 'The expired agent-device session could not be closed; ownership remains fenced.' },
      });
    throw new AssistantPluginError(
      closed ? 'AGENT_DEVICE_SESSION_EXPIRED' : 'AGENT_DEVICE_CLEANUP_FAILED',
      closed ? 'The agent-device session expired and was closed.' : 'The expired agent-device session could not be closed; retry agent_device_close.',
      { retryable: !closed },
    );
  }
  return record;
}

function bestEffortClose(input: AssistantPluginActionExecutionInput, record: InteractionSessionRecord): boolean {
  const result = hooks.runCommand(executable(), ['close', '--session', record.sessionId, '--platform', 'ios', '--json'], {
    cwd: input.repoRoot,
    timeoutMs: 30_000,
    env: sessionEnv(input, record),
  });
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { success?: unknown };
    return parsed.success !== false;
  } catch {
    return true;
  }
}

function reconcileExpiredSessions(input: AssistantPluginActionExecutionInput): void {
  const nowMs = hooks.now().getTime();
  for (const record of listAgentDeviceInteractions(input.repoRoot)) {
    if (!isInteractionSessionActive(record.status) || nowMs < Date.parse(record.expiresAt)) continue;
    const closed = bestEffortClose(input, record);
    patchInteractionSession(input.repoRoot, record.provider, record.interactionId, closed
      ? {
        status: 'failed',
        error: { code: 'AGENT_DEVICE_SESSION_EXPIRED', message: 'The agent-device session expired and was closed before opening another session.' },
      }
      : {
        status: 'closing',
        error: { code: 'AGENT_DEVICE_CLEANUP_FAILED', message: 'The expired agent-device session could not be closed; ownership remains fenced.' },
      });
  }
}

function failSession(input: AssistantPluginActionExecutionInput, record: InteractionSessionRecord, error: unknown): never {
  const closed = bestEffortClose(input, record);
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device command failed.',
    retryable: false,
  });
  patchInteractionSession(input.repoRoot, record.provider, record.interactionId, closed
    ? {
      status: 'failed',
      error: { code: normalized.code, message: normalized.message },
    }
    : {
      status: 'closing',
      error: { code: 'AGENT_DEVICE_CLEANUP_FAILED', message: `${normalized.message}; cleanup failed and ownership remains fenced.` },
    });
  if (!closed) {
    throw new AssistantPluginError('AGENT_DEVICE_CLEANUP_FAILED', 'The agent-device action failed and its session could not be closed; retry agent_device_close.', {
      retryable: true,
      details: { originalCode: normalized.code, interactionId: record.interactionId },
    });
  }
  throw normalized;
}

function runSessionCommand(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  args: string[],
  failureCode: string,
  timeoutMs = 60_000,
): Record<string, unknown> {
  try {
    return runJson(input, [...args, '--session', record.sessionId, '--platform', 'ios', '--json'], {
      record,
      timeoutMs,
      failureCode,
    });
  } catch (error) {
    return failSession(input, record, error);
  }
}

function runSessionCommandAttempt(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  args: string[],
  failureCode: string,
  timeoutMs = 60_000,
): Record<string, unknown> {
  return runJson(input, [...args, '--session', record.sessionId, '--platform', 'ios', '--json'], {
    record,
    timeoutMs,
    failureCode,
  });
}

function isStaleAccessibilityRefError(error: unknown): boolean {
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device command failed.',
    retryable: false,
  });
  const evidence = `${normalized.message}\n${JSON.stringify(normalized.details ?? {})}`;
  return /(?:accessibility|element|ref|@e\d+)/i.test(evidence)
    && /(?:stale|expired|missing|not[\s_-]*found|no[\s_-]*such)/i.test(evidence);
}

function stringEvidence(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringEvidence(entry, output));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => stringEvidence(entry, output));
  }
  return output;
}

function interactiveRef(value: unknown, terms: RegExp): string | undefined {
  for (const text of stringEvidence(value)) {
    for (const line of text.split('\n')) {
      if (!terms.test(line)) continue;
      const match = line.match(/@e\d+(?:~s\d+)?/);
      if (match) return match[0];
    }
  }
  return undefined;
}

function boundedVisibleText(value: unknown, query: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const text of stringEvidence(value)) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim().split(query).join('<query>');
      if (!line || line.length > 500 || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (Buffer.byteLength(lines.join('\n'), 'utf8') >= 8_000) return lines;
    }
  }
  return lines;
}

function validateJdQuery(value: unknown): string {
  const query = requireString(value, 'query');
  if (query.length > MAX_JD_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `query must be at most ${MAX_JD_QUERY_LENGTH} printable characters.`, { retryable: false });
  }
  if (SENSITIVE_SEMANTICS.test(query)) {
    throw new AssistantPluginError('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED', 'JD search accepts product-information queries only; credentials, verification, checkout, purchase and payment semantics are blocked.', { retryable: false });
  }
  return query;
}

function batchInput(value: unknown, index: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}].input must be an object.`, { retryable: false });
  }
  return value as Record<string, unknown>;
}

function assertBatchKeys(
  input: Record<string, unknown>,
  allowed: string[],
  index: number,
  kind: AgentDeviceBatchKind,
): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      `steps[${index}] ${kind} contains unsupported fields: ${unexpected.join(', ')}`,
      { retryable: false },
    );
  }
}

function batchInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function assertPhysicalBatchText(record: InteractionSessionRecord, values: Array<string | undefined>): void {
  if (record.provider !== DEVICE_PROVIDER) return;
  if (values.some((value) => value && SENSITIVE_SEMANTICS.test(value))) {
    throw new AssistantPluginError(
      'IOS_DEVICE_SENSITIVE_ACTION_BLOCKED',
      'Batch steps involving credentials, verification, biometrics, checkout, purchase or payment require human interaction.',
      { retryable: false },
    );
  }
}

function nativeBatchTarget(target: string): Record<string, unknown> {
  const ref = target.match(/^@?(e\d+(?:~s\d+)?)$/i)?.[1];
  return ref
    ? { kind: 'ref', ref }
    : { kind: 'selector', selector: target };
}

function prepareAgentDeviceBatch(
  rawSteps: unknown,
  record: InteractionSessionRecord,
): PreparedAgentDeviceBatch {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > MAX_BATCH_STEPS) {
    throw new AssistantPluginError(
      'PLUGIN_ACTION_ARGUMENT_INVALID',
      `steps must contain between 1 and ${MAX_BATCH_STEPS} typed entries.`,
      { retryable: false },
    );
  }

  const nativeSteps: PreparedAgentDeviceBatch['nativeSteps'] = [];
  const redactions: string[] = [];
  rawSteps.forEach((rawStep, index) => {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}] must be an object.`, { retryable: false });
    }
    const step = rawStep as Record<string, unknown>;
    const rawKind = requireString(step.kind, `steps[${index}].kind`);
    if (!BATCH_KINDS.includes(rawKind as AgentDeviceBatchKind)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported batch step kind: ${rawKind}`, { retryable: false });
    }
    const kind = rawKind as AgentDeviceBatchKind;
    const input = batchInput(step.input ?? {}, index);
    let nativeInput: Record<string, unknown>;

    switch (kind) {
      case 'snapshot': {
        assertBatchKeys(input, ['interactive', 'raw', 'depth', 'scope', 'diff', 'force_full', 'timeout_ms'], index, kind);
        const scope = optionalString(input.scope);
        nativeInput = {
          ...(input.interactive === true ? { interactive: true } : {}),
          ...(input.raw === true ? { raw: true } : {}),
          ...(input.diff === true ? { diff: true } : {}),
          ...(input.force_full === true ? { forceFull: true } : {}),
          ...(scope ? { scope } : {}),
          ...(typeof input.depth === 'number'
            ? { depth: batchInteger(input.depth, 8, 1, 20) }
            : {}),
          ...(typeof input.timeout_ms === 'number'
            ? { timeoutMs: batchInteger(input.timeout_ms, 15_000, 100, 60_000) }
            : {}),
        };
        break;
      }
      case 'press': {
        assertBatchKeys(input, ['target', 'x', 'y'], index, kind);
        const target = optionalString(input.target);
        const hasPoint = typeof input.x === 'number' && typeof input.y === 'number';
        if (!target && !hasPoint) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}] press requires target or x/y.`, { retryable: false });
        }
        assertPhysicalBatchText(record, [target]);
        nativeInput = target
          ? { target: nativeBatchTarget(target), settle: true }
          : {
            target: { kind: 'point', x: Number(input.x), y: Number(input.y) },
            settle: true,
          };
        break;
      }
      case 'fill': {
        assertBatchKeys(input, ['target', 'text', 'delay_ms'], index, kind);
        const target = requireString(input.target, `steps[${index}].input.target`);
        if (typeof input.text !== 'string') {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `steps[${index}] fill requires text.`, { retryable: false });
        }
        const text = input.text;
        assertPhysicalBatchText(record, [target, text]);
        redactions.push(text);
        nativeInput = {
          target: nativeBatchTarget(target),
          text,
          settle: true,
          ...(typeof input.delay_ms === 'number'
            ? { delayMs: batchInteger(input.delay_ms, 0, 0, 5_000) }
            : {}),
        };
        break;
      }
      case 'scroll': {
        assertBatchKeys(input, ['direction', 'amount'], index, kind);
        const direction = requireString(input.direction, `steps[${index}].input.direction`);
        if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported batch scroll direction: ${direction}`, { retryable: false });
        }
        nativeInput = {
          direction,
          ...(typeof input.amount === 'number'
            ? { amount: batchInteger(input.amount, 1, 1, 100) }
            : {}),
        };
        break;
      }
      case 'keyboard': {
        assertBatchKeys(input, ['action'], index, kind);
        const action = requireString(input.action, `steps[${index}].input.action`);
        if (!['status', 'dismiss'].includes(action)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported keyboard action: ${action}`, { retryable: false });
        }
        nativeInput = { action };
        break;
      }
      case 'wait': {
        assertBatchKeys(input, ['wait_type', 'text', 'selector', 'duration_ms', 'quiet_ms', 'timeout_ms'], index, kind);
        const waitType = optionalString(input.wait_type) ?? 'stable';
        if (!['stable', 'text', 'selector', 'duration'].includes(waitType)) {
          throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unsupported wait type: ${waitType}`, { retryable: false });
        }
        const timeoutMs = batchInteger(input.timeout_ms, 15_000, 100, 60_000);
        if (waitType === 'text') {
          const text = requireString(input.text, `steps[${index}].input.text`);
          assertPhysicalBatchText(record, [text]);
          nativeInput = { kind: 'text', text, timeoutMs };
        } else if (waitType === 'selector') {
          const selector = requireString(input.selector, `steps[${index}].input.selector`);
          assertPhysicalBatchText(record, [selector]);
          nativeInput = { kind: 'selector', selector, timeoutMs };
        } else if (waitType === 'duration') {
          nativeInput = {
            kind: 'duration',
            durationMs: batchInteger(input.duration_ms, 500, 0, 60_000),
          };
        } else {
          nativeInput = {
            kind: 'stable',
            quietMs: batchInteger(input.quiet_ms, 500, 100, 5_000),
            timeoutMs,
          };
        }
        break;
      }
      case 'back': {
        assertBatchKeys(input, [], index, kind);
        nativeInput = {};
        break;
      }
    }
    nativeSteps.push({ command: kind, input: nativeInput });
  });

  return { nativeSteps, redactions };
}

function runSessionBatch(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  prepared: PreparedAgentDeviceBatch,
  timeoutMs = 120_000,
): Record<string, unknown> {
  let result: unknown = runSessionCommand(input, record, [
    'batch',
    '--steps', JSON.stringify(prepared.nativeSteps),
    '--on-error', 'stop',
    '--max-steps', String(MAX_BATCH_STEPS),
    '--cost',
  ], 'AGENT_DEVICE_BATCH_FAILED', timeoutMs);
  for (const text of prepared.redactions) result = redactExactText(result, text);
  return result as Record<string, unknown>;
}

function runSessionBatchAttempt(
  input: AssistantPluginActionExecutionInput,
  record: InteractionSessionRecord,
  prepared: PreparedAgentDeviceBatch,
  timeoutMs = 120_000,
): Record<string, unknown> {
  let result: unknown = runSessionCommandAttempt(input, record, [
    'batch',
    '--steps', JSON.stringify(prepared.nativeSteps),
    '--on-error', 'stop',
    '--max-steps', String(MAX_BATCH_STEPS),
    '--cost',
  ], 'AGENT_DEVICE_BATCH_FAILED', timeoutMs);
  for (const text of prepared.redactions) result = redactExactText(result, text);
  return result as Record<string, unknown>;
}

function subActionInput(
  input: AssistantPluginActionExecutionInput,
  actionId: string,
  args: Record<string, unknown>,
): AssistantPluginActionExecutionInput {
  return { ...input, actionId, args, requestId: `${input.requestId}:${actionId}` };
}

async function executeJdSearch(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const query = validateJdQuery(input.args.query);
  const deviceSelector = requireString(input.args.device, 'device');
  const selected = selectTarget(input, deviceSelector);
  if (selected.kind !== 'device') {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'agent_device_jd_search requires one exact connected physical iPhone.', {
      retryable: false,
      details: { device: { id: selected.id, name: selected.name, kind: selected.kind } },
    });
  }
  const sharedArgs = {
    device: selected.name,
    team_id: optionalString(input.args.team_id),
    runner_bundle_id: optionalString(input.args.runner_bundle_id),
    developer_dir: optionalString(input.args.developer_dir),
  };
  const opened = await executeIosAgentDeviceAction(subActionInput(input, 'agent_device_open', {
    ...sharedArgs,
    app: JD_BUNDLE_ID,
    // Foreground an already-running app by default. Relaunch is opt-in because
    // it restarts app state and pays another cold-start/navigation cost.
    relaunch: input.args.relaunch === true,
  }));
  const interaction = opened.interaction as InteractionSessionRecord | undefined;
  if (!interaction) {
    throw new AssistantPluginError('AGENT_DEVICE_OPEN_FAILED', 'agent-device did not return an interaction for JD.', { retryable: false });
  }
  const interactionId = interaction.interactionId;
  let finalSnapshot: Record<string, unknown> | undefined;
  let screenshot: Record<string, unknown> | undefined;
  const resultText = optionalString(input.args.result_text);
  const resultSelector = optionalString(input.args.result_selector);
  const exactResultWait = Boolean(resultText || resultSelector);
  const resultScope = optionalString(input.args.result_scope);
  const snapshotDepth = batchInteger(input.args.snapshot_depth, 20, 1, 20);
  const accessibilityEvidenceTier = exactResultWait
    ? 'exact_wait'
    : resultScope
      ? 'scoped_snapshot'
      : 'full_snapshot';
  let initialAccessibilitySnapshot = false;
  let staleRefRecovery = false;
  let nativeBatchRequests = 0;
  let nativeBatchSteps = 0;
  try {
    // A caller may retain both a fast accessibility ref and a stable selector.
    // Prefer the selector because refs are snapshot-scoped and may be stale after
    // app foregrounding or navigation; fall back to the ref for compatibility.
    let searchTarget = optionalString(input.args.search_selector) ?? optionalString(input.args.search_target);
    if (!searchTarget) {
      initialAccessibilitySnapshot = true;
      const initialSnapshot = await executeIosAgentDeviceAction(subActionInput(input, 'agent_device_snapshot', {
        interaction_id: interactionId,
        interactive: true,
      }));
      searchTarget = interactiveRef(initialSnapshot, /搜索|搜一搜|search|searchfield|请输入/i);
    }
    if (!searchTarget) {
      throw new AssistantPluginError('JD_SEARCH_FIELD_NOT_FOUND', 'JD opened, but no bounded accessibility search field was found. Provide search_target from agent_device_snapshot evidence.', {
        retryable: false,
      });
    }

    const submitTarget = optionalString(input.args.submit_selector) ?? optionalString(input.args.submit_target);
    const waitStep: AgentDeviceBatchStep = resultText
      ? { kind: 'wait', input: { wait_type: 'text', text: resultText, timeout_ms: 15_000 } }
      : resultSelector
        ? { kind: 'wait', input: { wait_type: 'selector', selector: resultSelector, timeout_ms: 15_000 } }
        : { kind: 'wait', input: { wait_type: 'stable', quiet_ms: 500, timeout_ms: 15_000 } };
    const evidenceSteps: AgentDeviceBatchStep[] = exactResultWait
      ? [waitStep]
      : [
        waitStep,
        {
          kind: 'snapshot',
          input: {
            interactive: true,
            depth: snapshotDepth,
            ...(resultScope ? { scope: resultScope } : {}),
          },
        },
      ];
    const record = requireRecord(subActionInput(input, 'agent_device_batch', { interaction_id: interactionId }));
    let fillStep: AgentDeviceBatchStep = {
      kind: 'fill',
      input: { target: searchTarget, text: query, delay_ms: 20 },
    };
    const cachedSearchRef = !optionalString(input.args.search_selector) && /^@e\d+(?:~s\d+)?$/.test(searchTarget);
    if (cachedSearchRef) {
      nativeBatchRequests += 1;
      nativeBatchSteps += 1;
      try {
        runSessionBatchAttempt(input, record, prepareAgentDeviceBatch([fillStep], record), 20_000);
      } catch (error) {
        if (!isStaleAccessibilityRefError(error)) return failSession(input, record, error);
        staleRefRecovery = true;
        initialAccessibilitySnapshot = true;
        let refreshedSnapshot: Record<string, unknown>;
        try {
          refreshedSnapshot = runSessionCommandAttempt(
            input,
            record,
            ['snapshot', '--interactive'],
            'AGENT_DEVICE_SNAPSHOT_FAILED',
            30_000,
          );
        } catch (snapshotError) {
          return failSession(input, record, snapshotError);
        }
        const refreshedTarget = interactiveRef(refreshedSnapshot, /搜索|搜一搜|search|searchfield|请输入/i);
        if (!refreshedTarget) {
          return failSession(input, record, new AssistantPluginError(
            'JD_SEARCH_FIELD_NOT_FOUND',
            'The cached JD search ref was stale and no replacement search field was found.',
            { retryable: false },
          ));
        }
        fillStep = { kind: 'fill', input: { target: refreshedTarget, text: query, delay_ms: 20 } };
        nativeBatchRequests += 1;
        nativeBatchSteps += 1;
        runSessionBatch(input, record, prepareAgentDeviceBatch([fillStep], record), 20_000);
      }
    }
    if (submitTarget) {
      nativeBatchRequests += 1;
      nativeBatchSteps += (cachedSearchRef ? 1 : 2) + evidenceSteps.length;
      finalSnapshot = runSessionBatch(
        input,
        record,
        prepareAgentDeviceBatch([
          ...(cachedSearchRef ? [] : [fillStep]),
          { kind: 'press', input: { target: submitTarget } },
          ...evidenceSteps,
        ], record),
        30_000,
      );
    } else {
      nativeBatchRequests += cachedSearchRef ? 1 : 2;
      nativeBatchSteps += (cachedSearchRef ? 0 : 1) + evidenceSteps.length;
      // agent-device 0.19.3 exposes keyboard return only through the CLI
      // command, not the Node batch keyboard schema (status/dismiss only).
      if (!cachedSearchRef) runSessionBatch(input, record, prepareAgentDeviceBatch([fillStep], record), 20_000);
      runSessionCommand(input, record, ['keyboard', 'return'], 'JD_SEARCH_SUBMIT_FAILED');
      finalSnapshot = runSessionBatch(
        input,
        record,
        prepareAgentDeviceBatch(evidenceSteps, record),
        30_000,
      );
    }
    screenshot = await executeIosAgentDeviceAction(subActionInput(input, 'agent_device_screenshot', {
      interaction_id: interactionId,
      label: 'jd-search-results',
      max_size: 1600,
    }));
  } finally {
    await executeIosAgentDeviceAction(subActionInput(input, 'agent_device_close', { interaction_id: interactionId }));
  }
  return {
    provider: 'agent-device',
    workflow: 'jd_product_search',
    app: JD_BUNDLE_ID,
    device: selected,
    query: '<redacted>',
    runnerReadiness: 'verified_by_open',
    executionPlan: {
      relaunch: input.args.relaunch === true,
      nativeBatchRequests,
      nativeBatchSteps,
      exactResultWait,
      accessibilityEvidenceTier,
      initialAccessibilitySnapshot,
      staleRefRecovery,
      accessibilitySnapshotRequests: (initialAccessibilitySnapshot ? 1 : 0) + (exactResultWait ? 0 : 1),
      fullAccessibilitySnapshot: accessibilityEvidenceTier === 'full_snapshot',
      resultScope: resultScope ?? null,
      snapshotDepth: exactResultWait ? null : snapshotDepth,
    },
    visibleResultText: boundedVisibleText(finalSnapshot, query),
    result: bounded(redactExactText(finalSnapshot, query)),
    artifactCandidates: screenshot?.artifactCandidates,
    interaction: readAgentDeviceInteraction(input.repoRoot, interactionId),
    safety: {
      allowed: 'product_information_search',
      blocked: ['credentials', 'verification', 'biometrics', 'checkout', 'purchase', 'payment'],
    },
  };
}

export function isIosAgentDeviceAction(actionId: string): boolean {
  return actionId.startsWith('agent_device_');
}

export function iosAgentDeviceCapabilities(): AssistantPluginCapability[] {
  const actions = iosAgentDeviceActions().map((action) => action.actionId);
  return [
    {
      capabilityId: 'ios-agent-device-simulator',
      title: 'agent-device iOS Simulator',
      description: `Optional agent-device ${IOS_AGENT_DEVICE_VERSION} sessions for bounded iOS Simulator inspection and interaction.`,
      scopes: ['ios.discover', 'ios.simulator'],
      actions,
    },
    {
      capabilityId: 'ios-agent-device-physical',
      title: 'agent-device physical iPhone',
      description: `Optional signed agent-device ${IOS_AGENT_DEVICE_VERSION} XCTest sessions for one exact connected physical iPhone.`,
      scopes: ['ios.discover', 'ios.device'],
      actions,
    },
  ];
}

export function iosAgentDeviceActions(): AssistantPluginActionDescriptor[] {
  const read = [{ resource: 'repo-state' as const, mode: 'write' as const }];
  const write = [
    { resource: 'workspace' as const, mode: 'write' as const },
    { resource: 'repo-state' as const, mode: 'write' as const },
  ];
  const interactionProperty = { interaction_id: { type: 'string' } };
  return [
    {
      actionId: 'agent_device_status', title: 'agent-device status',
      description: `Check for the exact optional agent-device ${IOS_AGENT_DEVICE_VERSION} CLI.`,
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 5_000, cancellable: true, idempotent: true,
      scopes: ['ios.discover'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'agent_device_doctor', title: 'agent-device doctor',
      description: 'Run the typed local iOS doctor command. This may warm the local XCTest runner cache.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 4 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.discover', 'ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { app: { type: 'string' }, device: { type: 'string' }, team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' } }, additionalProperties: false },
    },
    {
      actionId: 'agent_device_prepare', title: 'Prepare signed iOS Runner',
      description: 'Build, sign, install and health-check the agent-device XCTest Runner for one exact iOS target.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.discover', 'ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object', properties: { device: { type: 'string' }, team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' } },
        required: ['device'], additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_open', title: 'Open agent-device iOS session',
      description: 'Open an app on one exact connected physical iPhone or already-booted iOS Simulator.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 4 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object', properties: { app: { type: 'string' }, device: { type: 'string' }, relaunch: { type: 'boolean' }, team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' } },
        required: ['app'], additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_batch', title: 'Run fast typed iOS action batch',
      description: `Run up to ${MAX_BATCH_STEPS} allowlisted session steps in one agent-device process and one daemon request. Mutating steps always settle before the next step.`,
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 2 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object',
        properties: {
          ...interactionProperty,
          steps: {
            type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...BATCH_KINDS] },
                input: { type: 'object', additionalProperties: true },
              },
              required: ['kind', 'input'],
              additionalProperties: false,
            },
          },
          timeout_ms: { type: 'number' },
        },
        required: ['interaction_id', 'steps'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_jd_search', title: 'Search JD on a physical iPhone',
      description: 'Launch JD, enter one bounded non-sensitive product query, submit it, return visible result text and capture a PNG. Login, verification, checkout, purchase, payment and biometrics remain human-only.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10 * 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.device'], resourceClaims: write,
      argumentsSchema: {
        type: 'object', properties: {
          device: { type: 'string' }, query: { type: 'string' }, team_id: { type: 'string' }, runner_bundle_id: { type: 'string' }, developer_dir: { type: 'string' },
          search_target: { type: 'string' }, search_selector: { type: 'string' },
          submit_target: { type: 'string' }, submit_selector: { type: 'string' }, relaunch: { type: 'boolean' },
          result_text: { type: 'string' }, result_selector: { type: 'string' },
          result_scope: { type: 'string' }, snapshot_depth: { type: 'number' },
        },
        required: ['device', 'query'], additionalProperties: false,
      },
    },
    {
      actionId: 'agent_device_snapshot', title: 'Snapshot agent-device session',
      description: 'Capture bounded accessibility state from an active agent-device iOS session.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: read,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, interactive: { type: 'boolean' }, raw: { type: 'boolean' }, depth: { type: 'number' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_press', title: 'Press agent-device target',
      description: 'Press one ref, selector, or explicit coordinate pair and return a settled bounded diff.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, target: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_fill', title: 'Fill agent-device target',
      description: 'Replace non-sensitive text in one ref or selector and return a redacted settled diff. Use manual UI entry for passwords or verification codes.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, target: { type: 'string' }, text: { type: 'string' }, delay_ms: { type: 'number' } }, required: ['interaction_id', 'target', 'text'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_scroll', title: 'Scroll agent-device session',
      description: 'Scroll one active agent-device iOS session serially.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] }, amount: { type: 'number' } }, required: ['interaction_id', 'direction'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_screenshot', title: 'Capture agent-device screenshot',
      description: 'Capture a bounded PNG into Controller-owned iOS artifact storage.',
      readOnly: false, risk: 'workspace_write', confirmation: 'none', defaultTimeoutMs: 60_000, cancellable: true, idempotent: false,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, label: { type: 'string' }, overlay_refs: { type: 'boolean' }, max_size: { type: 'number' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_events', title: 'Read agent-device events',
      description: 'Read a bounded page of daemon-owned session events.',
      readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: read,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false },
    },
    {
      actionId: 'agent_device_close', title: 'Close agent-device session',
      description: 'Close the provider session. Shutdown applies only to simulators; physical iPhones are never shut down.',
      readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 60_000, cancellable: true, idempotent: true,
      scopes: ['ios.simulator', 'ios.device'], resourceClaims: write,
      argumentsSchema: { type: 'object', properties: { ...interactionProperty, shutdown_simulator: { type: 'boolean' } }, required: ['interaction_id'], additionalProperties: false },
    },
  ];
}

export async function executeIosAgentDeviceAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  if (input.actionId === 'agent_device_status') return { provider: 'agent-device', ...iosAgentDeviceStatus() };
  if (input.actionId === 'agent_device_close') {
    const interactionId = requireString(input.args.interaction_id, 'interaction_id');
    const existing = readAgentDeviceInteraction(input.repoRoot, interactionId);
    if (existing && !isInteractionSessionActive(existing.status)) {
      return { provider: 'agent-device', interaction: existing, alreadyClosed: true };
    }
  }
  requireDependency();

  if (input.actionId === 'agent_device_jd_search') return executeJdSearch(input);

  if (input.actionId === 'agent_device_doctor') {
    const selected = selectTarget(input, optionalString(input.args.device));
    const args = ['doctor', '--platform', 'ios', '--device', selected.name];
    const app = optionalString(input.args.app);
    if (app) args.push('--app', app);
    args.push('--json');
    return {
      provider: 'agent-device', version: IOS_AGENT_DEVICE_VERSION, device: selected,
      physicalDeviceSupported: selected.kind === 'device',
      result: bounded(runJson(input, args, {
        signing: signingFromArgs(input.args),
        failureCode: 'AGENT_DEVICE_DOCTOR_FAILED',
        timeoutMs: 4 * 60_000,
      })),
    };
  }

  if (input.actionId === 'agent_device_prepare') {
    const selected = selectTarget(input, requireString(input.args.device, 'device'));
    const signing = signingFromArgs(input.args);
    return {
      provider: 'agent-device', version: IOS_AGENT_DEVICE_VERSION, device: selected,
      physicalDeviceSupported: selected.kind === 'device',
      result: bounded(runJson(input, [
        'prepare', 'ios-runner', '--platform', 'ios', '--device', selected.name, '--timeout', '600000', '--json',
      ], {
        signing,
        failureCode: 'AGENT_DEVICE_PREPARE_FAILED',
        timeoutMs: 10 * 60_000,
      })),
    };
  }

  if (input.actionId === 'agent_device_open') {
    reconcileExpiredSessions(input);
    const app = requireString(input.args.app, 'app');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(app)) {
      throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'agent_device_open accepts an app name or bundle identifier, not a URL or tokenized deep link.', { retryable: false });
    }
    const selected = selectTarget(input, optionalString(input.args.device));
    const provider = providerForDevice(selected);
    const conflict = listAllIosInteractions(input.repoRoot).find((entry) =>
      isInteractionSessionActive(entry.status) && entry.targetId === selected.id);
    if (conflict) {
      throw new AssistantPluginError('PLUGIN_RESOURCE_BUSY', 'The selected iOS target already has an active interaction.', {
        retryable: true,
        details: { interactionId: conflict.interactionId, targetId: conflict.targetId },
      });
    }
    pruneInteractionSessions(input.repoRoot, provider, 100);
    const interactionId = `ios_agent_device_${randomUUID()}`;
    const createdAt = timestamp();
    const record: InteractionSessionRecord = {
      schemaVersion: 1,
      interactionId,
      provider,
      sessionId: `repo-harness-${sanitize(interactionId).slice(-40)}`,
      targetId: selected.id,
      status: 'starting',
      reason: selected.kind === 'simulator' ? 'ios_simulator_automation' : 'ios_physical_device_automation',
      instructions: app,
      owner: { repoId: input.repoId, requestId: input.requestId, jobId: input.jobId },
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(hooks.now().getTime() + SESSION_EXPIRY_MS).toISOString(),
    };
    writeInteractionSession(input.repoRoot, record);
    writeSigningConfig(input, interactionId, signingFromArgs(input.args));
    const args = ['open', app, '--device', selected.name];
    if (input.args.relaunch === true) args.push('--relaunch');
    try {
      const result = runJson(input, [...args, '--session', record.sessionId, '--platform', 'ios', '--json'], {
        record,
        timeoutMs: 4 * 60_000,
        failureCode: 'AGENT_DEVICE_OPEN_FAILED',
      });
      const active = patchInteractionSession(input.repoRoot, provider, interactionId, { status: 'waiting_for_user' }) ?? record;
      return {
        provider: 'agent-device',
        version: IOS_AGENT_DEVICE_VERSION,
        interaction: active,
        device: selected,
        physicalDeviceSupported: selected.kind === 'device',
        result: bounded(result),
      };
    } catch (error) {
      return failSession(input, record, error);
    }
  }

  const record = requireRecord(input, input.actionId === 'agent_device_close');
  switch (input.actionId) {
    case 'agent_device_batch': {
      const prepared = prepareAgentDeviceBatch(input.args.steps, record);
      const timeoutMs = batchInteger(input.args.timeout_ms, 120_000, 1_000, 180_000);
      return {
        provider: 'agent-device',
        interaction: record,
        batched: true,
        stepCount: prepared.nativeSteps.length,
        result: bounded(runSessionBatch(input, record, prepared, timeoutMs)),
      };
    }
    case 'agent_device_snapshot': {
      const args = ['snapshot'];
      if (input.args.interactive === true) args.push('-i');
      if (input.args.raw === true) args.push('--raw');
      if (typeof input.args.depth === 'number') args.push('--depth', String(Math.max(1, Math.min(20, Math.trunc(input.args.depth)))));
      return { provider: 'agent-device', interaction: record, result: bounded(runSessionCommand(input, record, args, 'AGENT_DEVICE_SNAPSHOT_FAILED')) };
    }
    case 'agent_device_press': {
      const target = optionalString(input.args.target);
      const hasPoint = typeof input.args.x === 'number' && typeof input.args.y === 'number';
      if (!target && !hasPoint) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'target or x/y is required.', { retryable: false });
      if (record.provider === DEVICE_PROVIDER && target && SENSITIVE_SEMANTICS.test(target)) {
        throw new AssistantPluginError('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED', 'Press targets involving credentials, verification, biometrics, checkout, purchase or payment require human interaction.', { retryable: false });
      }
      const args = ['press', ...(target ? [target] : [String(input.args.x), String(input.args.y)]), '--settle'];
      return { provider: 'agent-device', interaction: record, result: bounded(runSessionCommand(input, record, args, 'AGENT_DEVICE_PRESS_FAILED')) };
    }
    case 'agent_device_fill': {
      const target = requireString(input.args.target, 'target');
      const text = typeof input.args.text === 'string' ? input.args.text : undefined;
      if (text === undefined) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'text is required.', { retryable: false });
      if (record.provider === DEVICE_PROVIDER && (SENSITIVE_SEMANTICS.test(target) || SENSITIVE_SEMANTICS.test(text))) {
        throw new AssistantPluginError('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED', 'Sensitive text and credential, verification, checkout, purchase or payment targets require human interaction.', { retryable: false });
      }
      const args = ['fill', target, text, '--settle'];
      if (typeof input.args.delay_ms === 'number') args.push('--delay-ms', String(Math.max(0, Math.min(5_000, Math.trunc(input.args.delay_ms)))));
      const result = runSessionCommand(input, record, args, 'AGENT_DEVICE_FILL_FAILED');
      return { provider: 'agent-device', interaction: record, result: bounded(redactExactText(result, text)) };
    }
    case 'agent_device_scroll': {
      const direction = requireString(input.args.direction, 'direction');
      if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Unsupported scroll direction.', { retryable: false });
      }
      const args = ['scroll', direction];
      if (typeof input.args.amount === 'number') args.push(String(Math.max(1, Math.min(100, Math.trunc(input.args.amount)))));
      return { provider: 'agent-device', interaction: record, result: bounded(runSessionCommand(input, record, args, 'AGENT_DEVICE_SCROLL_FAILED')) };
    }
    case 'agent_device_screenshot': {
      const label = sanitize(optionalString(input.args.label) ?? 'screenshot');
      const path = join(artifactDir(input, record.interactionId), `${label}-${hooks.now().getTime()}.png`);
      const args = ['screenshot', path];
      if (input.args.overlay_refs === true) args.push('--overlay-refs');
      if (typeof input.args.max_size === 'number') args.push('--max-size', String(Math.max(320, Math.min(4_096, Math.trunc(input.args.max_size)))));
      const result = runSessionCommand(input, record, args, 'AGENT_DEVICE_SCREENSHOT_FAILED');
      if (!existsSync(path)) {
        return failSession(input, record, new AssistantPluginError('AGENT_DEVICE_SCREENSHOT_MISSING', 'agent-device succeeded without creating the requested screenshot.', { retryable: false }));
      }
      return {
        provider: 'agent-device', interaction: record, result: bounded(result),
        artifactCandidates: [{ kind: 'ios_agent_device_screenshot', mediaType: 'image/png', path }],
      };
    }
    case 'agent_device_events': {
      const args = ['events'];
      if (typeof input.args.limit === 'number') args.push(String(Math.max(1, Math.min(200, Math.trunc(input.args.limit)))));
      const cursor = optionalString(input.args.cursor);
      if (cursor) args.push(cursor);
      const result = runSessionCommand(input, record, args, 'AGENT_DEVICE_EVENTS_FAILED', 30_000);
      return { provider: 'agent-device', interaction: record, result: bounded(redactEventEvidence(result)) };
    }
    case 'agent_device_close': {
      if (!isInteractionSessionActive(record.status)) {
        return { provider: 'agent-device', interaction: record, alreadyClosed: true };
      }
      const args = ['close'];
      if (record.provider === SIMULATOR_PROVIDER && input.args.shutdown_simulator === true) args.push('--shutdown');
      patchInteractionSession(input.repoRoot, record.provider, record.interactionId, { status: 'closing' });
      try {
        const result = runJson(input, [...args, '--session', record.sessionId, '--platform', 'ios', '--json'], {
          record,
          timeoutMs: 60_000,
          failureCode: 'AGENT_DEVICE_CLOSE_FAILED',
        });
        const closed = patchInteractionSession(input.repoRoot, record.provider, record.interactionId, { status: 'closed' }) ?? record;
        return { provider: 'agent-device', interaction: closed, result: bounded(result) };
      } catch (error) {
        return failSession(input, record, error);
      }
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `ios/${input.actionId} is not supported.`, { retryable: false });
  }
}
