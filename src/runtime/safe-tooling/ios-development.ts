import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { spawnSync } from 'child_process';
import type { RepositoryRecord } from '../../cli/repositories/types';

export interface IosCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  command: string[];
}

export interface IosDevelopmentHooks {
  platform?: () => NodeJS.Platform;
  runCommand?: (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => IosCommandResult;
  now?: () => Date;
}

let hooks: IosDevelopmentHooks = {};

export function setIosDevelopmentHooksForTest(next: IosDevelopmentHooks): void {
  hooks = next;
}

export function resetIosDevelopmentHooksForTest(): void {
  hooks = {};
}

function platform(): NodeJS.Platform {
  return hooks.platform?.() ?? process.platform;
}

function now(): Date {
  return hooks.now?.() ?? new Date();
}

function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): IosCommandResult {
  if (hooks.runCommand) return hooks.runCommand(command, args, options);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf-8',
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
}

function dependencyError(message: string, details?: Record<string, unknown>) {
  return {
    ready: false,
    error: { code: 'IOS_DEPENDENCY_UNAVAILABLE', message, details },
  };
}

function assertDarwin() {
  if (platform() !== 'darwin') return dependencyError('iOS Simulator tooling is available only on macOS.', { platform: platform() });
  return undefined;
}

function safeRepoRelativePath(repoRoot: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const resolved = resolve(repoRoot, value);
  const rel = relative(resolve(repoRoot), resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('IOS_PATH_OUTSIDE_REPOSITORY: path must stay inside repository');
  return rel;
}

function safeArtifactDir(repository: RepositoryRecord, leaf: 'screenshots' | 'logs' | 'build-reports' | 'DerivedData'): string {
  const root = resolve(repository.canonicalRoot, '.repo-harness', 'ios', leaf);
  mkdirSync(root, { recursive: true });
  return root;
}

function timestamp(): string {
  return now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ios';
}

function boundedText(value: string, maxBytes = 20_000): { content: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf-8');
  if (buffer.byteLength <= maxBytes) return { content: value, truncated: false };
  return { content: buffer.subarray(Math.max(0, buffer.byteLength - maxBytes)).toString('utf-8'), truncated: true };
}

export function iosXcodeStatus() {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const xcodeSelect = runCommand('xcode-select', ['-p']);
  const xcodebuild = runCommand('xcodebuild', ['-version']);
  const simctl = runCommand('xcrun', ['simctl', 'help']);
  return {
    ready: xcodeSelect.ok && xcodebuild.ok && simctl.ok,
    platform: platform(),
    xcodeSelectPath: xcodeSelect.ok ? xcodeSelect.stdout.trim() : undefined,
    xcodebuildVersion: xcodebuild.ok ? xcodebuild.stdout.trim() : undefined,
    simctlAvailable: simctl.ok,
    problems: [
      ...(xcodeSelect.ok ? [] : [{ code: 'XCODE_SELECT_UNAVAILABLE', message: xcodeSelect.stderr || xcodeSelect.stdout }]),
      ...(xcodebuild.ok ? [] : [{ code: 'XCODEBUILD_UNAVAILABLE', message: xcodebuild.stderr || xcodebuild.stdout }]),
      ...(simctl.ok ? [] : [{ code: 'SIMCTL_UNAVAILABLE', message: simctl.stderr || simctl.stdout }]),
    ],
  };
}

export function iosSimulatorsList(input: { runtime?: string; name?: string } = {}) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const result = runCommand('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  if (!result.ok) return { ready: false, error: { code: 'SIMCTL_LIST_FAILED', message: result.stderr || result.stdout }, command: result.command };
  let parsed: { devices?: Record<string, Array<{ name?: string; udid?: string; state?: string; isAvailable?: boolean; availabilityError?: string }>> };
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { return { ready: false, error: { code: 'SIMCTL_JSON_INVALID', message: error instanceof Error ? error.message : String(error) } }; }
  const devices = Object.entries(parsed.devices ?? {}).flatMap(([runtime, entries]) => entries.map((entry) => ({
    runtime,
    name: entry.name ?? '',
    udid: entry.udid ?? '',
    state: entry.state ?? 'Unknown',
    available: entry.isAvailable !== false && !entry.availabilityError,
  }))).filter((device) => device.available && device.name && device.udid)
    .filter((device) => input.runtime ? device.runtime.includes(input.runtime) : true)
    .filter((device) => input.name ? device.name.includes(input.name) : true);
  return { ready: true, devices };
}

function findFiles(root: string, suffix: string, maxDepth = 3): string[] {
  const results: string[] = [];
  function visit(dir: string, depth: number) {
    if (depth > maxDepth || results.length > 50) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const entryName = String(entry.name);
      if (entryName === 'node_modules' || entryName === '.git' || entryName === '.repo-harness' || entryName === '.ai') continue;
      const path = join(dir, entryName);
      if (entry.isDirectory() && entryName.endsWith(suffix)) results.push(path);
      else if (entry.isDirectory()) visit(path, depth + 1);
    }
  }
  visit(root, 0);
  return results.sort();
}

export function iosProjectDiscover(repository: RepositoryRecord) {
  const root = repository.canonicalRoot;
  const workspaces = findFiles(root, '.xcworkspace').map((path) => relative(root, path));
  const projects = findFiles(root, '.xcodeproj').map((path) => relative(root, path));
  const packageSwift = existsSync(join(root, 'Package.swift')) ? 'Package.swift' : undefined;
  const infoPlists = findFiles(root, '.plist', 4).filter((path) => basename(path) === 'Info.plist').map((path) => relative(root, path));
  return {
    ready: workspaces.length > 0 || projects.length > 0 || Boolean(packageSwift),
    workspace: workspaces[0],
    project: projects[0],
    workspaces,
    projects,
    packageSwift,
    infoPlists,
    defaultContainer: workspaces[0] ? { type: 'workspace', path: workspaces[0] } : projects[0] ? { type: 'project', path: projects[0] } : packageSwift ? { type: 'package', path: packageSwift } : undefined,
  };
}

export function iosSchemesList(repository: RepositoryRecord, input: { workspace?: string; project?: string } = {}) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const discovered = iosProjectDiscover(repository);
  const workspace = safeRepoRelativePath(repository.canonicalRoot, input.workspace ?? discovered.workspace);
  const project = safeRepoRelativePath(repository.canonicalRoot, input.project ?? discovered.project);
  const args = workspace
    ? ['-list', '-json', '-workspace', workspace]
    : project
      ? ['-list', '-json', '-project', project]
      : ['-list', '-json'];
  const result = runCommand('xcodebuild', args, { cwd: repository.canonicalRoot, timeoutMs: 60_000 });
  if (!result.ok) return { ready: false, error: { code: 'XCODEBUILD_LIST_FAILED', message: result.stderr || result.stdout }, command: result.command };
  try {
    const parsed = JSON.parse(result.stdout) as { workspace?: { schemes?: string[] }; project?: { schemes?: string[] } };
    return { ready: true, workspace, project, schemes: parsed.workspace?.schemes ?? parsed.project?.schemes ?? [] };
  } catch (error) {
    return { ready: false, error: { code: 'XCODEBUILD_LIST_JSON_INVALID', message: error instanceof Error ? error.message : String(error) } };
  }
}

export function iosSimulatorBoot(input: { udid: string; openSimulator?: boolean; timeoutMs?: number }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  if (!udid) throw new Error('IOS_SIMULATOR_UDID_REQUIRED');
  const boot = runCommand('xcrun', ['simctl', 'boot', udid], { timeoutMs: input.timeoutMs ?? 60_000 });
  const alreadyBooted = /Unable to boot|current state: Booted|already booted/i.test(boot.stderr + boot.stdout);
  if (!boot.ok && !alreadyBooted) return { ready: false, booted: false, error: { code: 'SIMULATOR_BOOT_FAILED', message: boot.stderr || boot.stdout }, command: boot.command };
  if (input.openSimulator !== false) runCommand('open', ['-a', 'Simulator']);
  return { ready: true, booted: true, udid, alreadyBooted };
}

export function iosAppBuild(repository: RepositoryRecord, input: { scheme: string; udid?: string; workspace?: string; project?: string; configuration?: string; timeoutMs?: number }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const scheme = String(input.scheme ?? '').trim();
  if (!scheme) throw new Error('IOS_SCHEME_REQUIRED');
  const workspace = safeRepoRelativePath(repository.canonicalRoot, input.workspace);
  const project = safeRepoRelativePath(repository.canonicalRoot, input.project);
  const derivedDataPath = safeArtifactDir(repository, 'DerivedData');
  const args = ['build'];
  if (workspace) args.push('-workspace', workspace);
  else if (project) args.push('-project', project);
  args.push('-scheme', scheme, '-configuration', input.configuration ?? 'Debug');
  if (input.udid) args.push('-destination', `platform=iOS Simulator,id=${String(input.udid).trim()}`);
  else args.push('-destination', 'platform=iOS Simulator,name=iPhone 16 Pro');
  args.push('-derivedDataPath', derivedDataPath);
  const result = runCommand('xcodebuild', args, { cwd: repository.canonicalRoot, timeoutMs: input.timeoutMs ?? 10 * 60_000 });
  return {
    ready: result.ok,
    ok: result.ok,
    scheme,
    configuration: input.configuration ?? 'Debug',
    derivedDataPath: relative(repository.canonicalRoot, derivedDataPath),
    command: result.command,
    stdout: boundedText(result.stdout),
    stderr: boundedText(result.stderr),
    error: result.ok ? undefined : { code: 'IOS_BUILD_FAILED', message: (result.stderr || result.stdout).slice(0, 2000) },
  };
}

function assertRepoBoundedAppPath(repository: RepositoryRecord, appPath: string): string {
  const resolved = resolve(repository.canonicalRoot, appPath);
  const allowedRoot = resolve(repository.canonicalRoot, '.repo-harness', 'ios', 'DerivedData');
  const rel = relative(allowedRoot, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('IOS_APP_PATH_NOT_BOUNDED: app_path must be under .repo-harness/ios/DerivedData');
  if (!resolved.endsWith('.app')) throw new Error('IOS_APP_PATH_INVALID: app_path must end with .app');
  return resolved;
}

export function iosAppInstall(repository: RepositoryRecord, input: { udid: string; appPath: string }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  const appPath = assertRepoBoundedAppPath(repository, String(input.appPath ?? ''));
  const result = runCommand('xcrun', ['simctl', 'install', udid, appPath], { timeoutMs: 120_000 });
  return { ready: result.ok, installed: result.ok, udid, appPath: relative(repository.canonicalRoot, appPath), error: result.ok ? undefined : { code: 'IOS_INSTALL_FAILED', message: result.stderr || result.stdout } };
}

export function iosAppLaunch(input: { udid: string; bundleId: string; arguments?: string[]; waitMs?: number }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  const bundleId = String(input.bundleId ?? '').trim();
  if (!udid || !bundleId) throw new Error('IOS_LAUNCH_ARGUMENTS_REQUIRED');
  const launchArgs = Array.isArray(input.arguments) ? input.arguments.map(String).slice(0, 20) : [];
  const result = runCommand('xcrun', ['simctl', 'launch', udid, bundleId, ...launchArgs], { timeoutMs: 60_000 });
  return { ready: result.ok, launched: result.ok, udid, bundleId, stdout: result.stdout.trim(), error: result.ok ? undefined : { code: 'IOS_LAUNCH_FAILED', message: result.stderr || result.stdout } };
}

export function iosSimulatorScreenshot(repository: RepositoryRecord, input: { udid: string; label?: string }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  if (!udid) throw new Error('IOS_SIMULATOR_UDID_REQUIRED');
  const dir = safeArtifactDir(repository, 'screenshots');
  const file = join(dir, `${timestamp()}-${sanitize(input.label ?? udid)}.png`);
  const result = runCommand('xcrun', ['simctl', 'io', udid, 'screenshot', file], { timeoutMs: 60_000 });
  return {
    ready: result.ok,
    screenshot: result.ok ? relative(repository.canonicalRoot, file) : undefined,
    artifactType: 'ios_simulator_screenshot',
    udid,
    error: result.ok ? undefined : { code: 'IOS_SCREENSHOT_FAILED', message: result.stderr || result.stdout },
    safety: { boundedPath: true, arbitraryPathAccepted: false },
  };
}

export function iosSimulatorLogTail(repository: RepositoryRecord, input: { udid: string; process?: string; last?: string; maxBytes?: number }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  const predicate = input.process ? `process == "${String(input.process).replace(/"/g, '')}"` : 'process != ""';
  const result = runCommand('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', input.last ?? '2m', '--predicate', predicate], { timeoutMs: 60_000 });
  const text = boundedText(result.stdout || result.stderr, input.maxBytes ?? 20_000);
  const dir = safeArtifactDir(repository, 'logs');
  const file = join(dir, `${timestamp()}-${sanitize(input.process ?? udid)}.log`);
  writeFileSync(file, text.content, 'utf-8');
  return { ready: result.ok, path: relative(repository.canonicalRoot, file), content: text.content, truncated: text.truncated, error: result.ok ? undefined : { code: 'IOS_LOG_TAIL_FAILED', message: result.stderr || result.stdout } };
}

export function iosUiSmokeTest(repository: RepositoryRecord, input: { udid: string; scheme: string; bundleId: string; workspace?: string; project?: string; configuration?: string; appPath?: string; screenshotLabel?: string }) {
  const build = input.appPath ? undefined : iosAppBuild(repository, input);
  const installPath = input.appPath ?? undefined;
  const boot = iosSimulatorBoot({ udid: input.udid });
  const launch = iosAppLaunch({ udid: input.udid, bundleId: input.bundleId });
  const screenshot = iosSimulatorScreenshot(repository, { udid: input.udid, label: input.screenshotLabel ?? input.scheme });
  const logs = iosSimulatorLogTail(repository, { udid: input.udid, process: input.scheme, maxBytes: 12_000 });
  return { ready: Boolean((build === undefined || build.ready) && boot.ready && launch.ready && screenshot.ready), build, installPath, boot, launch, screenshot, logs };
}
