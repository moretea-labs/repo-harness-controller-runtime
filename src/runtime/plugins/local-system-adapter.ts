import { spawnSync } from 'child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { controllerSystemRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginHealth,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';

const PLUGIN_ID = 'local_system';
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_DIRECTORY_ENTRIES = 200;

interface LocalSystemTarget {
  targetKey: string;
  rootPath: string;
  createdAt: string;
  expiresAt: string;
  reason: string;
}

interface LocalSystemTargetStore {
  schemaVersion: 1;
  targets: LocalSystemTarget[];
}

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  command: string[];
}

export interface LocalSystemPluginHooks {
  now?: () => Date;
  runCommand?: (command: string, args: string[], timeoutMs?: number) => CommandResult;
}

let hooks: LocalSystemPluginHooks = {};

export function setLocalSystemPluginHooksForTest(next: LocalSystemPluginHooks): void {
  hooks = next;
}

export function resetLocalSystemPluginHooksForTest(): void {
  hooks = {};
}

function now(): string {
  return (hooks.now?.() ?? new Date()).toISOString();
}

function pluginRoot(controllerHome: string): string {
  const root = join(controllerSystemRoot(controllerHome), 'local-system');
  mkdirSync(root, { recursive: true });
  return root;
}

function targetsPath(controllerHome: string): string {
  return join(pluginRoot(controllerHome), 'targets.json');
}

function loadTargets(controllerHome: string): LocalSystemTargetStore {
  try {
    const store = readJsonFile<LocalSystemTargetStore>(targetsPath(controllerHome));
    return { schemaVersion: 1, targets: Array.isArray(store.targets) ? store.targets : [] };
  } catch {
    return { schemaVersion: 1, targets: [] };
  }
}

function saveTargets(controllerHome: string, store: LocalSystemTargetStore): void {
  writeJsonAtomic(targetsPath(controllerHome), store);
}

function activeTargets(controllerHome: string): LocalSystemTarget[] {
  const current = Date.now();
  return loadTargets(controllerHome).targets
    .filter((target) => Date.parse(target.expiresAt) > current)
    .sort((left, right) => left.targetKey.localeCompare(right.targetKey));
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === 'string' ? String(args[key]).trim() : '';
  if (!value) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `${key} is required.`, { retryable: false });
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = typeof args[key] === 'string' ? String(args[key]).trim() : '';
  return value || undefined;
}

function bounded(value: string, maxBytes = MAX_OUTPUT_BYTES): { content: string; truncated: boolean; byteLength: number } {
  const source = Buffer.from(value, 'utf8');
  if (source.byteLength <= maxBytes) return { content: value, truncated: false, byteLength: source.byteLength };
  return {
    content: source.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
    byteLength: source.byteLength,
  };
}

function run(command: string, args: string[], timeoutMs = 30_000): CommandResult {
  if (hooks.runCommand) return hooks.runCommand(command, args, timeoutMs);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: Math.max(1_000, Math.min(Math.trunc(timeoutMs), 120_000)),
    maxBuffer: MAX_OUTPUT_BYTES * 2,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.error?.message ?? ''),
    command: [command, ...args],
  };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new AssistantPluginError('LOCAL_SYSTEM_PATH_INVALID', 'No existing parent directory was found.', { retryable: false });
    current = parent;
  }
  return current;
}

function resolveTarget(controllerHome: string, targetKey: string): LocalSystemTarget {
  const target = activeTargets(controllerHome).find((entry) => entry.targetKey === targetKey);
  if (!target) throw new AssistantPluginError('LOCAL_SYSTEM_TARGET_UNAVAILABLE', `Target ${targetKey} is missing or expired.`, { retryable: false });
  return target;
}

function resolveTargetPath(
  controllerHome: string,
  targetKey: string,
  relativePath: string | undefined,
  options: { mustExist: boolean; directory?: boolean },
): { target: LocalSystemTarget; root: string; path: string; relativePath: string } {
  const target = resolveTarget(controllerHome, targetKey);
  const raw = (relativePath ?? '').trim();
  if (raw.includes('\0') || isAbsolute(raw)) {
    throw new AssistantPluginError('LOCAL_SYSTEM_PATH_OUTSIDE_TARGET', 'Path must be relative to the authorized target.', { retryable: false });
  }
  const root = realpathSync(target.rootPath);
  const candidate = resolve(root, raw || '.');
  if (!inside(root, candidate)) {
    throw new AssistantPluginError('LOCAL_SYSTEM_PATH_OUTSIDE_TARGET', 'Path traversal outside the authorized target is not allowed.', { retryable: false });
  }
  const ancestor = realpathSync(findExistingAncestor(candidate));
  if (!inside(root, ancestor)) {
    throw new AssistantPluginError('LOCAL_SYSTEM_SYMLINK_ESCAPE', 'A path component resolves outside the authorized target.', { retryable: false });
  }
  if (existsSync(candidate)) {
    const canonical = realpathSync(candidate);
    if (!inside(root, canonical)) {
      throw new AssistantPluginError('LOCAL_SYSTEM_SYMLINK_ESCAPE', 'The requested path resolves outside the authorized target.', { retryable: false });
    }
    if (options.directory && !statSync(canonical).isDirectory()) {
      throw new AssistantPluginError('LOCAL_SYSTEM_PATH_NOT_DIRECTORY', 'The requested path is not a directory.', { retryable: false });
    }
    return { target, root, path: canonical, relativePath: relative(root, canonical) };
  }
  if (options.mustExist) {
    throw new AssistantPluginError('LOCAL_SYSTEM_PATH_NOT_FOUND', `Path ${raw || '.'} does not exist.`, { retryable: false });
  }
  return { target, root, path: candidate, relativePath: relative(root, candidate) };
}

function authorizeTarget(input: AssistantPluginActionExecutionInput): Record<string, unknown> {
  const targetKey = sanitizeFileComponent(requiredString(input.args, 'target_key'));
  const requestedRoot = requiredString(input.args, 'root_path');
  if (!isAbsolute(requestedRoot) || !existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) {
    throw new AssistantPluginError('LOCAL_SYSTEM_TARGET_ROOT_INVALID', 'root_path must be an existing absolute directory.', { retryable: false });
  }
  const rootPath = realpathSync(requestedRoot);
  const expiresInMinutes = Math.max(1, Math.min(Math.trunc(Number(input.args.expires_in_minutes ?? 480)), 1_440));
  const createdAt = now();
  const target: LocalSystemTarget = {
    targetKey,
    rootPath,
    createdAt,
    expiresAt: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
    reason: requiredString(input.args, 'reason'),
  };
  const store = loadTargets(input.controllerHome);
  store.targets = store.targets.filter((entry) => entry.targetKey !== targetKey);
  store.targets.push(target);
  saveTargets(input.controllerHome, store);
  return { target, storage: 'controllerHome/system/local-system/targets.json', repositoryRegistered: false };
}

function systemSnapshot(): Record<string, unknown> {
  const processes = run('ps', ['-Ao', 'pid=,ppid=,%cpu=,%mem=,comm=', '-r']);
  const vm = run('vm_stat', []);
  const pressure = run('memory_pressure', []);
  return {
    platform: process.platform,
    generatedAt: now(),
    processes: bounded(processes.stdout || processes.stderr),
    virtualMemory: bounded(vm.stdout || vm.stderr),
    memoryPressure: bounded(pressure.stdout || pressure.stderr),
    commands: [processes.command, vm.command, pressure.command],
  };
}

function processDetail(pidValue: unknown): Record<string, unknown> {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'pid must be a positive integer.', { retryable: false });
  const detail = run('ps', ['-p', String(pid), '-o', 'pid=,ppid=,user=,%cpu=,%mem=,etime=,state=,command=']);
  return { pid, found: detail.ok && Boolean(detail.stdout.trim()), output: bounded(detail.stdout || detail.stderr), command: detail.command };
}

function actions(): AssistantPluginActionDescriptor[] {
  const controllerRead = [{ resource: 'repo-state' as const, mode: 'read' as const }];
  const controllerWrite = [{ resource: 'repo-state' as const, mode: 'write' as const }];
  const targetProperties = {
    target_key: { type: 'string' },
    path: { type: 'string' },
  };
  return [
    { actionId: 'system_snapshot', title: 'System snapshot', description: 'Read bounded CPU, process, memory, and pressure diagnostics.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true, scopes: ['local-system.read'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'process_detail', title: 'Process detail', description: 'Read bounded details for one process id.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.read'], resourceClaims: [], argumentsSchema: { type: 'object', properties: { pid: { type: 'number' } }, required: ['pid'], additionalProperties: false } },
    { actionId: 'open_application', title: 'Open application', description: 'Open one macOS application by name or bundle id.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.open'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { app_name: { type: 'string' }, bundle_id: { type: 'string' } }, additionalProperties: false } },
    { actionId: 'list_targets', title: 'List filesystem targets', description: 'List active expiring local filesystem grants.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 10_000, cancellable: true, idempotent: true, scopes: ['local-system.files.read'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'authorize_target', title: 'Authorize filesystem target', description: 'Authorize one existing absolute directory under an expiring target key.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' }, root_path: { type: 'string' }, expires_in_minutes: { type: 'number' }, reason: { type: 'string' } }, required: ['target_key', 'root_path', 'reason'], additionalProperties: false } },
    { actionId: 'list_directory', title: 'List directory', description: 'List a bounded directory snapshot below an authorized target.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.read'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key'], additionalProperties: false } },
    { actionId: 'read_text', title: 'Read text file', description: 'Read a bounded UTF-8 text file below an authorized target.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.read'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: { ...targetProperties, max_chars: { type: 'number' } }, required: ['target_key', 'path'], additionalProperties: false } },
    { actionId: 'create_directory', title: 'Create directory', description: 'Create a directory below an authorized target without leaving that root.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 15_000, cancellable: true, idempotent: true, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key', 'path'], additionalProperties: false } },
    { actionId: 'copy_file', title: 'Copy file', description: 'Copy a file between authorized targets without overwriting.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { source_target_key: { type: 'string' }, source_path: { type: 'string' }, destination_target_key: { type: 'string' }, destination_path: { type: 'string' } }, required: ['source_target_key', 'source_path', 'destination_target_key', 'destination_path'], additionalProperties: false } },
    { actionId: 'move_file', title: 'Move file', description: 'Move a file between authorized targets without overwriting.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { source_target_key: { type: 'string' }, source_path: { type: 'string' }, destination_target_key: { type: 'string' }, destination_path: { type: 'string' } }, required: ['source_target_key', 'source_path', 'destination_target_key', 'destination_path'], additionalProperties: false } },
    { actionId: 'rename_file', title: 'Rename file', description: 'Rename a file inside one authorized target without overwriting.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.files.write'], resourceClaims: controllerWrite, argumentsSchema: { type: 'object', properties: { target_key: { type: 'string' }, source_path: { type: 'string' }, destination_path: { type: 'string' } }, required: ['target_key', 'source_path', 'destination_path'], additionalProperties: false } },
    { actionId: 'reveal_in_finder', title: 'Reveal in Finder', description: 'Reveal an authorized file or directory in Finder.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.open'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key', 'path'], additionalProperties: false } },
    { actionId: 'open_file', title: 'Open file', description: 'Open an authorized local file with its default application.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: ['local-system.open'], resourceClaims: controllerRead, argumentsSchema: { type: 'object', properties: targetProperties, required: ['target_key', 'path'], additionalProperties: false } },
  ];
}

function health(): AssistantPluginHealth {
  const ready = process.platform === 'darwin';
  return {
    state: ready ? 'ready' : 'degraded',
    checkedAt: now(),
    ready,
    probed: true,
    errors: [],
    warnings: ready ? [] : ['Application opening and macOS diagnostics require macOS.'],
    details: { provider: 'local-macos', scope: 'controller', repositoryRegistrationRequired: false },
  };
}

function permissions(): AssistantPluginPermissionScope[] {
  return [
    { scope: 'local-system.read', mode: 'read', description: 'Read bounded local process and memory diagnostics.', granted: true, required: true },
    { scope: 'local-system.open', mode: 'write', description: 'Open applications or authorized files.', granted: true, required: false },
    { scope: 'local-system.files.read', mode: 'read', description: 'Read files only below active target grants.', granted: true, required: false },
    { scope: 'local-system.files.write', mode: 'write', description: 'Create, copy, move, or rename files below active target grants.', granted: true, required: false },
  ];
}

function capabilities(): AssistantPluginCapability[] {
  return [
    { capabilityId: 'local-system-diagnostics', title: 'Local diagnostics', description: 'Inspect CPU, processes, and memory with bounded typed commands.', scopes: ['local-system.read'], actions: ['system_snapshot', 'process_detail'] },
    { capabilityId: 'local-system-open', title: 'Open local applications and files', description: 'Open applications and authorized files without arbitrary shell access.', scopes: ['local-system.open'], actions: ['open_application', 'reveal_in_finder', 'open_file'] },
    { capabilityId: 'local-system-files', title: 'Authorized local files', description: 'Use expiring target grants for bounded local file operations.', scopes: ['local-system.files.read', 'local-system.files.write'], actions: ['list_targets', 'authorize_target', 'list_directory', 'read_text', 'create_directory', 'copy_file', 'move_file', 'rename_file'] },
  ];
}

export function buildLocalSystemPluginManifest(previousRevision = 0, previousUpdatedAt?: string): AssistantPluginManifest {
  const currentHealth = health();
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: PLUGIN_ID,
    provider: 'local-macos',
    displayName: 'Local System Assistant',
    pluginVersion: '1.0.0',
    authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: ['controllerHome:system/local-system'] },
    enabled: true,
    lifecycle: { state: currentHealth.ready ? 'enabled' : 'degraded', reason: currentHealth.ready ? 'Local system capabilities are ready.' : currentHealth.warnings[0] },
    health: currentHealth,
    permissions: permissions(),
    capabilities: capabilities(),
    actions: actions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

function filePair(input: AssistantPluginActionExecutionInput): { source: string; destination: string } {
  const source = resolveTargetPath(input.controllerHome, requiredString(input.args, 'source_target_key'), requiredString(input.args, 'source_path'), { mustExist: true });
  const destination = resolveTargetPath(input.controllerHome, requiredString(input.args, 'destination_target_key'), requiredString(input.args, 'destination_path'), { mustExist: false });
  if (existsSync(destination.path)) throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'Destination already exists; overwrite is not allowed.', { retryable: false });
  if (!statSync(source.path).isFile()) throw new AssistantPluginError('LOCAL_SYSTEM_SOURCE_NOT_FILE', 'Source must be a file.', { retryable: false });
  mkdirSync(dirname(destination.path), { recursive: true });
  return { source: source.path, destination: destination.path };
}

export async function executeLocalSystemPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  switch (input.actionId) {
    case 'system_snapshot': return systemSnapshot();
    case 'process_detail': return processDetail(input.args.pid);
    case 'open_application': {
      const appName = optionalString(input.args, 'app_name');
      const bundleId = optionalString(input.args, 'bundle_id');
      if ((!appName && !bundleId) || (appName && bundleId)) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Provide exactly one of app_name or bundle_id.', { retryable: false });
      }
      const command = bundleId ? ['open', '-b', bundleId] : ['open', '-a', appName as string];
      const opened = run(command[0], command.slice(1));
      if (!opened.ok) throw new AssistantPluginError('LOCAL_SYSTEM_OPEN_FAILED', opened.stderr || opened.stdout, { retryable: true, details: { command } });
      return { opened: true, command };
    }
    case 'list_targets': return { targets: activeTargets(input.controllerHome), repositoryRegistered: false };
    case 'authorize_target': return authorizeTarget(input);
    case 'list_directory': {
      const resolved = resolveTargetPath(input.controllerHome, requiredString(input.args, 'target_key'), optionalString(input.args, 'path'), { mustExist: true, directory: true });
      const entries = readdirSync(resolved.path, { withFileTypes: true }).slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      }));
      return { targetKey: resolved.target.targetKey, path: resolved.relativePath, entries, truncated: entries.length === MAX_DIRECTORY_ENTRIES };
    }
    case 'read_text': {
      const resolved = resolveTargetPath(input.controllerHome, requiredString(input.args, 'target_key'), requiredString(input.args, 'path'), { mustExist: true });
      if (!statSync(resolved.path).isFile()) throw new AssistantPluginError('LOCAL_SYSTEM_PATH_NOT_FILE', 'The requested path is not a file.', { retryable: false });
      const maxChars = Math.max(1, Math.min(Math.trunc(Number(input.args.max_chars ?? 20_000)), MAX_TEXT_CHARS));
      const content = readFileSync(resolved.path, 'utf8');
      return { targetKey: resolved.target.targetKey, path: resolved.relativePath, content: content.slice(0, maxChars), truncated: content.length > maxChars };
    }
    case 'create_directory': {
      const resolved = resolveTargetPath(input.controllerHome, requiredString(input.args, 'target_key'), requiredString(input.args, 'path'), { mustExist: false });
      if (existsSync(resolved.path) && !statSync(resolved.path).isDirectory()) throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'A non-directory already exists at the destination.', { retryable: false });
      mkdirSync(resolved.path, { recursive: true });
      return { created: true, targetKey: resolved.target.targetKey, path: resolved.relativePath };
    }
    case 'copy_file': {
      const pair = filePair(input);
      copyFileSync(pair.source, pair.destination, constants.COPYFILE_EXCL);
      return { copied: true, source: pair.source, destination: pair.destination, overwrite: false };
    }
    case 'move_file': {
      const pair = filePair(input);
      renameSync(pair.source, pair.destination);
      return { moved: true, source: pair.source, destination: pair.destination, overwrite: false };
    }
    case 'rename_file': {
      const targetKey = requiredString(input.args, 'target_key');
      const source = resolveTargetPath(input.controllerHome, targetKey, requiredString(input.args, 'source_path'), { mustExist: true });
      const destination = resolveTargetPath(input.controllerHome, targetKey, requiredString(input.args, 'destination_path'), { mustExist: false });
      if (existsSync(destination.path)) throw new AssistantPluginError('LOCAL_SYSTEM_DESTINATION_EXISTS', 'Destination already exists; overwrite is not allowed.', { retryable: false });
      mkdirSync(dirname(destination.path), { recursive: true });
      renameSync(source.path, destination.path);
      return { renamed: true, source: source.relativePath, destination: destination.relativePath, overwrite: false };
    }
    case 'reveal_in_finder':
    case 'open_file': {
      const resolved = resolveTargetPath(input.controllerHome, requiredString(input.args, 'target_key'), requiredString(input.args, 'path'), { mustExist: true });
      const command = input.actionId === 'reveal_in_finder' ? ['open', '-R', resolved.path] : ['open', resolved.path];
      const opened = run(command[0], command.slice(1));
      if (!opened.ok) throw new AssistantPluginError('LOCAL_SYSTEM_OPEN_FAILED', opened.stderr || opened.stdout, { retryable: true, details: { command } });
      return { opened: true, targetKey: resolved.target.targetKey, path: resolved.relativePath, command };
    }
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `local_system/${input.actionId} is not supported.`, { retryable: false });
  }
}

export const localSystemPluginAdapter = {
  pluginId: PLUGIN_ID,
  scope: 'controller' as const,
  buildManifest: buildLocalSystemPluginManifest,
  executeAction: executeLocalSystemPluginAction,
};
