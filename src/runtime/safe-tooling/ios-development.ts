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
  sleep?: (ms: number) => void;
}

let hooks: IosDevelopmentHooks = {};

export function setIosDevelopmentHooksForTest(next: IosDevelopmentHooks): void {
  hooks = next;
}

export function resetIosDevelopmentHooksForTest(): void {
  hooks = {};
}

export function iosDevelopmentPlatform(): NodeJS.Platform {
  return hooks.platform?.() ?? process.platform;
}

function platform(): NodeJS.Platform {
  return iosDevelopmentPlatform();
}

function now(): Date {
  return hooks.now?.() ?? new Date();
}

function sleep(ms: number): void {
  const bounded = Math.max(0, Math.min(Math.trunc(ms), 30_000));
  if (bounded === 0) return;
  if (hooks.sleep) {
    hooks.sleep(bounded);
    return;
  }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, bounded);
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

function safeArtifactDir(
  repository: RepositoryRecord,
  leaf: 'screenshots' | 'logs' | 'build-reports' | 'DerivedData',
  overrideRoot?: string,
): string {
  const root = overrideRoot
    ? resolve(overrideRoot, leaf)
    : resolve(repository.canonicalRoot, '.repo-harness', 'ios', leaf);
  mkdirSync(root, { recursive: true });
  return root;
}

function artifactRelativePath(repository: RepositoryRecord, absolutePath: string, overrideRoot?: string): string {
  if (overrideRoot) {
    const rel = relative(resolve(overrideRoot), resolve(absolutePath));
    if (rel && !rel.startsWith(`..${sep}`) && rel !== '..') return `controller-artifacts/ios/${rel}`;
  }
  return relative(repository.canonicalRoot, absolutePath);
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
      else if (entry.isFile() && entryName.endsWith(suffix)) results.push(path);
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
  const timeoutMs = input.timeoutMs ?? 60_000;
  const boot = runCommand('xcrun', ['simctl', 'boot', udid], { timeoutMs });
  const alreadyBooted = /Unable to boot|current state: Booted|already booted/i.test(boot.stderr + boot.stdout);
  if (!boot.ok && !alreadyBooted) {
    return { ready: false, booted: false, error: { code: 'SIMULATOR_BOOT_FAILED', message: boot.stderr || boot.stdout }, command: boot.command };
  }
  const readiness = runCommand('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeoutMs });
  if (!readiness.ok) {
    return {
      ready: false,
      booted: true,
      udid,
      alreadyBooted,
      ownership: alreadyBooted ? 'reused' : 'started_by_work',
      command: boot.command,
      readinessCommand: readiness.command,
      error: { code: 'SIMULATOR_BOOTSTATUS_FAILED', message: readiness.stderr || readiness.stdout },
    };
  }
  if (input.openSimulator !== false) runCommand('open', ['-a', 'Simulator']);
  return {
    ready: true,
    booted: true,
    udid,
    alreadyBooted,
    ownership: alreadyBooted ? 'reused' : 'started_by_work',
    command: boot.command,
    readinessCommand: readiness.command,
  };
}

export function iosSimulatorShutdown(input: { udid: string; timeoutMs?: number }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  if (!udid) throw new Error('IOS_SIMULATOR_UDID_REQUIRED');
  const result = runCommand('xcrun', ['simctl', 'shutdown', udid], { timeoutMs: input.timeoutMs ?? 60_000 });
  const alreadyShutdown = /current state: Shutdown|already shutdown|Unable to shutdown/i.test(result.stderr + result.stdout);
  return {
    ready: result.ok || alreadyShutdown,
    shutdown: result.ok || alreadyShutdown,
    udid,
    alreadyShutdown,
    command: result.command,
    error: result.ok || alreadyShutdown ? undefined : { code: 'SIMULATOR_SHUTDOWN_FAILED', message: result.stderr || result.stdout },
  };
}

export function iosAppBuild(repository: RepositoryRecord, input: { scheme?: string; udid?: string; workspace?: string; project?: string; configuration?: string; timeoutMs?: number; simulatorName?: string }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const listed = iosSchemesList(repository, { workspace: input.workspace, project: input.project });
  if (!listed.ready) return listed;
  const listedReady = listed as { ready: true; workspace?: string; project?: string; schemes: string[] };
  const scheme = String(input.scheme ?? listedReady.schemes?.[0] ?? '').trim();
  if (!scheme) throw new Error('IOS_SCHEME_REQUIRED: provide scheme or share at least one Xcode scheme');
  const workspace = safeRepoRelativePath(repository.canonicalRoot, input.workspace ?? listedReady.workspace);
  const project = safeRepoRelativePath(repository.canonicalRoot, input.project ?? listedReady.project);
  const derivedDataRoot = safeArtifactDir(repository, 'DerivedData');
  const derivedDataPath = join(derivedDataRoot, `${timestamp()}-${sanitize(scheme)}`);
  mkdirSync(derivedDataPath, { recursive: true });
  const args = ['build'];
  if (workspace) args.push('-workspace', workspace);
  else if (project) args.push('-project', project);
  args.push('-scheme', scheme, '-configuration', input.configuration ?? 'Debug');
  if (input.udid) args.push('-destination', `platform=iOS Simulator,id=${String(input.udid).trim()}`);
  else args.push('-destination', 'platform=iOS Simulator,name=' + (input.simulatorName ?? 'iPhone 16 Pro'));
  args.push('-derivedDataPath', derivedDataPath);
  const result = runCommand('xcodebuild', args, { cwd: repository.canonicalRoot, timeoutMs: input.timeoutMs ?? 10 * 60_000 });
  const builtApps = findBuiltApps(repository, derivedDataPath);
  const selected = selectBuiltAppProduct(scheme, builtApps);
  const productError = result.ok ? selected.error : undefined;
  return {
    ready: result.ok && Boolean(selected.appPath),
    ok: result.ok && Boolean(selected.appPath),
    scheme,
    configuration: input.configuration ?? 'Debug',
    derivedDataPath: relative(repository.canonicalRoot, derivedDataPath),
    appPath: selected.appPath,
    builtApps,
    command: result.command,
    stdout: boundedText(result.stdout),
    stderr: boundedText(result.stderr),
    error: result.ok
      ? productError
      : { code: 'IOS_BUILD_FAILED', message: (result.stderr || result.stdout).slice(0, 2000) },
  };
}

function findBuiltApps(repository: RepositoryRecord, buildRoot: string): string[] {
  const root = resolve(buildRoot);
  const apps: string[] = [];
  function visit(dir: string, depth: number) {
    if (depth > 8 || apps.length > 25) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, String(entry.name));
      if (entry.isDirectory() && String(entry.name).endsWith('.app')) apps.push(relative(repository.canonicalRoot, path));
      else if (entry.isDirectory()) visit(path, depth + 1);
    }
  }
  visit(root, 0);
  return apps.sort();
}

function normalizedProductName(value: string): string {
  return value.replace(/\.app$/i, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function selectBuiltAppProduct(scheme: string, builtApps: string[]): {
  appPath?: string;
  error?: { code: string; message: string; candidates?: string[] };
} {
  const productionCandidates = builtApps.filter((candidate) => {
    const name = basename(candidate);
    return !/(?:tests?|uitests?|xctrunner|runner|testhost)\.app$/i.test(name);
  });
  if (productionCandidates.length === 0) {
    return { error: { code: 'IOS_BUILD_PRODUCT_MISSING', message: 'Build succeeded but no application product was found in this build-specific DerivedData directory.' } };
  }
  const normalizedScheme = normalizedProductName(scheme);
  const exact = productionCandidates.filter((candidate) => normalizedProductName(basename(candidate)) === normalizedScheme);
  if (exact.length === 1) return { appPath: exact[0] };
  if (productionCandidates.length === 1) return { appPath: productionCandidates[0] };
  return {
    error: {
      code: 'IOS_BUILD_PRODUCT_AMBIGUOUS',
      message: `Build produced multiple application products for scheme ${scheme}; pass a more specific scheme or product configuration.`,
      candidates: productionCandidates,
    },
  };
}

function readBuiltAppBundleId(repository: RepositoryRecord, appPath: string): string | undefined {
  const appRoot = assertRepoBoundedAppPath(repository, appPath);
  const plist = join(appRoot, 'Info.plist');
  if (!existsSync(plist)) return undefined;
  const plutil = runCommand('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
  return plutil.ok && plutil.stdout.trim() ? plutil.stdout.trim() : undefined;
}

function chooseSimulatorUdid(input: { udid?: string; simulatorName?: string }): string {
  const requested = String(input.udid ?? '').trim();
  if (requested) return requested;
  const preferred = iosSimulatorsList({ name: input.simulatorName ?? 'iPhone 16 Pro' });
  if (preferred.ready) {
    const preferredReady = preferred as { ready: true; devices: Array<{ udid: string }> };
    if (preferredReady.devices[0]?.udid) return preferredReady.devices[0].udid;
  }
  const fallback = iosSimulatorsList();
  if (fallback.ready) {
    const fallbackReady = fallback as { ready: true; devices: Array<{ udid: string }> };
    if (fallbackReady.devices[0]?.udid) return fallbackReady.devices[0].udid;
  }
  throw new Error('IOS_SIMULATOR_UNAVAILABLE: no available simulator was found');
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
  const waitMs = Math.max(0, Math.min(Math.trunc(input.waitMs ?? 1_500), 15_000));
  if (result.ok) sleep(waitMs);
  return {
    ready: result.ok,
    launched: result.ok,
    udid,
    bundleId,
    waitMs,
    stdout: result.stdout.trim(),
    error: result.ok ? undefined : { code: 'IOS_LAUNCH_FAILED', message: result.stderr || result.stdout },
  };
}

export function iosSimulatorScreenshot(repository: RepositoryRecord, input: { udid: string; label?: string; artifactRoot?: string }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  if (!udid) throw new Error('IOS_SIMULATOR_UDID_REQUIRED');
  const dir = safeArtifactDir(repository, 'screenshots', input.artifactRoot);
  const file = join(dir, `${timestamp()}-${sanitize(input.label ?? udid)}.png`);
  const result = runCommand('xcrun', ['simctl', 'io', udid, 'screenshot', file], { timeoutMs: 60_000 });
  return {
    ready: result.ok,
    screenshot: result.ok ? artifactRelativePath(repository, file, input.artifactRoot) : undefined,
    absolutePath: result.ok ? file : undefined,
    artifactType: 'ios_simulator_screenshot',
    udid,
    command: result.command,
    error: result.ok ? undefined : { code: 'IOS_SCREENSHOT_FAILED', message: result.stderr || result.stdout },
    safety: { boundedPath: true, arbitraryPathAccepted: false },
  };
}

export function iosSimulatorLogTail(repository: RepositoryRecord, input: { udid: string; process?: string; last?: string; maxBytes?: number; artifactRoot?: string }) {
  const unsupported = assertDarwin();
  if (unsupported) return unsupported;
  const udid = String(input.udid ?? '').trim();
  const predicate = input.process ? `process == "${String(input.process).replace(/"/g, '')}"` : 'process != ""';
  const result = runCommand('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', input.last ?? '2m', '--predicate', predicate], { timeoutMs: 60_000 });
  const text = boundedText(result.stdout || result.stderr, input.maxBytes ?? 20_000);
  const dir = safeArtifactDir(repository, 'logs', input.artifactRoot);
  const file = join(dir, `${timestamp()}-${sanitize(input.process ?? udid)}.log`);
  writeFileSync(file, text.content, 'utf-8');
  return {
    ready: result.ok,
    path: artifactRelativePath(repository, file, input.artifactRoot),
    absolutePath: file,
    content: text.content,
    truncated: text.truncated,
    command: result.command,
    error: result.ok ? undefined : { code: 'IOS_LOG_TAIL_FAILED', message: result.stderr || result.stdout },
  };
}

export type IosSmokeStageId =
  | 'project_discovery'
  | 'scheme_selection'
  | 'build'
  | 'simulator_preparation'
  | 'install'
  | 'launch'
  | 'screenshot'
  | 'logs';

export type IosSmokeStageStatus = 'passed' | 'failed' | 'skipped';

export interface IosSmokeStageResult {
  stage: IosSmokeStageId;
  status: IosSmokeStageStatus;
  summary: string;
  command?: string[];
  evidence?: Record<string, unknown>;
  repairHint?: string;
  artifacts?: string[];
}

export interface IosSmokeReviewInput {
  udid?: string;
  simulatorName?: string;
  scheme?: string;
  bundleId?: string;
  workspace?: string;
  project?: string;
  configuration?: string;
  appPath?: string;
  screenshotLabel?: string;
  skipBuild?: boolean;
  launchWaitMs?: number;
  cleanupPolicy?: 'keep' | 'shutdown_on_success' | 'shutdown_always';
  artifactRoot?: string;
}

function stagePassed(stage: IosSmokeStageId, summary: string, extra: Partial<IosSmokeStageResult> = {}): IosSmokeStageResult {
  return { stage, status: 'passed', summary, ...extra };
}

function stageFailed(stage: IosSmokeStageId, summary: string, repairHint: string, extra: Partial<IosSmokeStageResult> = {}): IosSmokeStageResult {
  return { stage, status: 'failed', summary, repairHint, ...extra };
}

function stageSkipped(stage: IosSmokeStageId, summary: string): IosSmokeStageResult {
  return { stage, status: 'skipped', summary };
}

/**
 * Staged iOS smoke review. Each stage records independent evidence; later stages
 * are skipped when an earlier stage fails, without erasing successful evidence.
 */
export function iosSmokeReview(repository: RepositoryRecord, input: IosSmokeReviewInput = {}) {
  const stages: IosSmokeStageResult[] = [];
  const artifacts: string[] = [];
  const commands: string[][] = [];
  let blockedStage: IosSmokeStageId | undefined;
  let overallStatus: 'passed' | 'failed' = 'passed';
  const cleanupPolicy = input.cleanupPolicy ?? 'keep';
  let simulatorOwnership: 'reused' | 'started_by_work' | undefined;
  let simulatorCleanup: ReturnType<typeof iosSimulatorShutdown> | undefined;

  const cleanupSimulator = (successful: boolean) => {
    if (simulatorOwnership !== 'started_by_work') return undefined;
    if (cleanupPolicy === 'keep') return undefined;
    if (cleanupPolicy === 'shutdown_on_success' && !successful) return undefined;
    simulatorCleanup = iosSimulatorShutdown({ udid });
    if (simulatorCleanup && 'command' in simulatorCleanup && Array.isArray(simulatorCleanup.command)) {
      commands.push(simulatorCleanup.command as string[]);
    }
    return simulatorCleanup;
  };

  const failRemaining = (fromIndex: number, reason: string) => {
    const remaining: IosSmokeStageId[] = [
      'project_discovery', 'scheme_selection', 'build', 'simulator_preparation',
      'install', 'launch', 'screenshot', 'logs',
    ].slice(fromIndex) as IosSmokeStageId[];
    for (const stage of remaining) {
      if (!stages.some((entry) => entry.stage === stage)) {
        stages.push(stageSkipped(stage, reason));
      }
    }
  };

  // 1. project_discovery
  const discovered = iosProjectDiscover(repository);
  if (!discovered.ready) {
    overallStatus = 'failed';
    blockedStage = 'project_discovery';
    stages.push(stageFailed(
      'project_discovery',
      'No Xcode workspace, project, or Package.swift was discovered.',
      'Add an .xcworkspace/.xcodeproj or Package.swift under the repository root.',
      { evidence: discovered as unknown as Record<string, unknown> },
    ));
    failRemaining(1, 'Skipped because project_discovery failed.');
    return { ready: false, overallStatus, blockedStage, stages, artifacts, commands, discovery: discovered };
  }
  stages.push(stagePassed('project_discovery', `Discovered ${discovered.defaultContainer?.type ?? 'project'} at ${discovered.defaultContainer?.path ?? '(unknown)'}.`, {
    evidence: {
      workspace: discovered.workspace,
      project: discovered.project,
      packageSwift: discovered.packageSwift,
      infoPlists: discovered.infoPlists?.slice(0, 10),
      defaultContainer: discovered.defaultContainer,
    },
  }));

  // 2. scheme_selection
  let selectedScheme = String(input.scheme ?? '').trim();
  let schemesList: ReturnType<typeof iosSchemesList> | undefined;
  const platformBlock = assertDarwin();
  if (platformBlock) {
    overallStatus = 'failed';
    blockedStage = 'scheme_selection';
    stages.push(stageFailed('scheme_selection', platformBlock.error?.message ?? 'iOS tooling unavailable on this platform.', 'Run smoke review on macOS with Xcode installed.', {
      evidence: platformBlock as unknown as Record<string, unknown>,
    }));
    failRemaining(2, 'Skipped because scheme_selection failed.');
    return { ready: false, overallStatus, blockedStage, stages, artifacts, commands, discovery: discovered };
  }

  schemesList = iosSchemesList(repository, { workspace: input.workspace ?? discovered.workspace, project: input.project ?? discovered.project });
  if (schemesList && 'command' in schemesList && Array.isArray(schemesList.command)) commands.push(schemesList.command as string[]);
  if (!schemesList.ready) {
    overallStatus = 'failed';
    blockedStage = 'scheme_selection';
    const message = 'error' in schemesList && schemesList.error && typeof schemesList.error === 'object' && 'message' in schemesList.error
      ? String((schemesList.error as { message?: string }).message ?? 'xcodebuild -list failed')
      : 'xcodebuild -list failed';
    stages.push(stageFailed('scheme_selection', message, 'Ensure Xcode is installed and the project opens cleanly in Xcode, then re-run list_schemes.', {
      command: 'command' in schemesList ? schemesList.command as string[] : undefined,
      evidence: schemesList as unknown as Record<string, unknown>,
    }));
    failRemaining(2, 'Skipped because scheme_selection failed.');
    return { ready: false, overallStatus, blockedStage, stages, artifacts, commands, discovery: discovered, schemes: schemesList };
  }

  const availableSchemes = (schemesList as { ready: true; schemes: string[] }).schemes;
  if (!selectedScheme) selectedScheme = availableSchemes[0] ?? '';
  if (!selectedScheme) {
    overallStatus = 'failed';
    blockedStage = 'scheme_selection';
    stages.push(stageFailed(
      'scheme_selection',
      'No schemes were available for the discovered project.',
      'Create a shared scheme in Xcode or pass scheme explicitly.',
      { evidence: { schemes: availableSchemes, workspace: discovered.workspace, project: discovered.project } },
    ));
    failRemaining(2, 'Skipped because scheme_selection failed.');
    return { ready: false, overallStatus, blockedStage, stages, artifacts, commands, discovery: discovered, schemes: schemesList };
  }
  if (availableSchemes.length > 0 && !availableSchemes.includes(selectedScheme)) {
    overallStatus = 'failed';
    blockedStage = 'scheme_selection';
    stages.push(stageFailed(
      'scheme_selection',
      `Requested scheme "${selectedScheme}" is not in the project scheme list.`,
      `Choose one of: ${availableSchemes.slice(0, 12).join(', ') || '(none)'}.`,
      { evidence: { requestedScheme: selectedScheme, schemes: availableSchemes } },
    ));
    failRemaining(2, 'Skipped because scheme_selection failed.');
    return { ready: false, overallStatus, blockedStage, stages, artifacts, commands, discovery: discovered, schemes: schemesList };
  }
  stages.push(stagePassed('scheme_selection', `Selected scheme ${selectedScheme}.`, {
    evidence: { scheme: selectedScheme, schemes: availableSchemes },
    command: 'command' in schemesList ? schemesList.command as string[] : undefined,
  }));

  // 3. build
  let appPath = String(input.appPath ?? '').trim();
  let buildResult: ReturnType<typeof iosAppBuild> | undefined;
  let udid = '';
  try {
    udid = chooseSimulatorUdid(input);
  } catch (error) {
    // simulator udid selection deferred to simulator_preparation when prebuilt app is used
    udid = String(input.udid ?? '').trim();
  }

  if (input.skipBuild && appPath) {
    stages.push(stagePassed('build', `Skipped build; using provided app_path ${appPath}.`, {
      evidence: { appPath, skipped: true },
    }));
  } else {
    buildResult = iosAppBuild(repository, {
      scheme: selectedScheme,
      udid: udid || undefined,
      simulatorName: input.simulatorName,
      workspace: input.workspace ?? discovered.workspace,
      project: input.project ?? discovered.project,
      configuration: input.configuration,
    });
    if (buildResult && 'command' in buildResult && Array.isArray(buildResult.command)) commands.push(buildResult.command as string[]);
    if (!buildResult.ready) {
      overallStatus = 'failed';
      blockedStage = 'build';
      const message = buildResult && 'error' in buildResult && buildResult.error
        ? String((buildResult.error as { message?: string }).message ?? 'Build failed')
        : 'Build failed';
      // Persist build log evidence when present
      if (buildResult && 'stdout' in buildResult) {
        const reportDir = safeArtifactDir(repository, 'build-reports', input.artifactRoot);
        const reportFile = join(reportDir, `${timestamp()}-build.log`);
        const reportBody = [
          `command: ${Array.isArray(buildResult.command) ? buildResult.command.join(' ') : ''}`,
          '',
          typeof buildResult.stdout === 'object' && buildResult.stdout && 'content' in buildResult.stdout
            ? String((buildResult.stdout as { content: string }).content)
            : '',
          typeof buildResult.stderr === 'object' && buildResult.stderr && 'content' in buildResult.stderr
            ? String((buildResult.stderr as { content: string }).content)
            : '',
        ].join('\n');
        writeFileSync(reportFile, reportBody, 'utf-8');
        const rel = artifactRelativePath(repository, reportFile, input.artifactRoot);
        artifacts.push(rel);
      }
      stages.push(stageFailed('build', message, 'Inspect xcodebuild output, fix compile errors, then re-run smoke_review.', {
        command: 'command' in buildResult ? buildResult.command as string[] : undefined,
        evidence: {
          scheme: selectedScheme,
          derivedDataPath: 'derivedDataPath' in buildResult ? buildResult.derivedDataPath : undefined,
          stdout: 'stdout' in buildResult ? buildResult.stdout : undefined,
          stderr: 'stderr' in buildResult ? buildResult.stderr : undefined,
        },
        artifacts: artifacts.slice(),
      }));
      failRemaining(3, 'Skipped because build failed.');
      return {
        ready: false,
        overallStatus,
        blockedStage,
        stages,
        artifacts,
        commands,
        discovery: discovered,
        schemes: schemesList,
        scheme: selectedScheme,
        build: buildResult,
      };
    }
    appPath = String(('appPath' in buildResult ? buildResult.appPath : '') || appPath || '');
    if (!appPath) {
      overallStatus = 'failed';
      blockedStage = 'build';
      stages.push(stageFailed(
        'build',
        'Build completed without producing a .app under .repo-harness/ios/DerivedData.',
        'Confirm the scheme builds an iOS app target and DerivedData path is writable.',
        { evidence: buildResult as unknown as Record<string, unknown> },
      ));
      failRemaining(3, 'Skipped because build failed.');
      return {
        ready: false, overallStatus, blockedStage, stages, artifacts, commands,
        discovery: discovered, schemes: schemesList, scheme: selectedScheme, build: buildResult,
      };
    }
    stages.push(stagePassed('build', `Built scheme ${selectedScheme} → ${appPath}.`, {
      command: 'command' in buildResult ? buildResult.command as string[] : undefined,
      evidence: {
        scheme: selectedScheme,
        appPath,
        derivedDataPath: 'derivedDataPath' in buildResult ? buildResult.derivedDataPath : undefined,
        builtApps: 'builtApps' in buildResult ? buildResult.builtApps : undefined,
      },
    }));
  }

  // 4. simulator_preparation
  try {
    if (!udid) udid = chooseSimulatorUdid(input);
  } catch (error) {
    overallStatus = 'failed';
    blockedStage = 'simulator_preparation';
    stages.push(stageFailed(
      'simulator_preparation',
      error instanceof Error ? error.message : String(error),
      'Install an iOS Simulator runtime in Xcode, or pass udid/simulator_name explicitly.',
    ));
    failRemaining(4, 'Skipped because simulator_preparation failed.');
    return {
      ready: false, overallStatus, blockedStage, stages, artifacts, commands,
      discovery: discovered, schemes: schemesList, scheme: selectedScheme, build: buildResult, udid,
    };
  }
  const boot = iosSimulatorBoot({ udid });
  if (boot && 'command' in boot && Array.isArray(boot.command)) commands.push(boot.command as string[]);
  if (boot && 'readinessCommand' in boot && Array.isArray(boot.readinessCommand)) commands.push(boot.readinessCommand as string[]);
  simulatorOwnership = 'ownership' in boot && (boot.ownership === 'reused' || boot.ownership === 'started_by_work')
    ? boot.ownership
    : undefined;
  if (!boot.ready) {
    overallStatus = 'failed';
    blockedStage = 'simulator_preparation';
    stages.push(stageFailed(
      'simulator_preparation',
      ('error' in boot && boot.error ? String((boot.error as { message?: string }).message) : 'Simulator boot failed'),
      'Open Simulator.app, boot a device manually, or pick another udid from list_simulators.',
      { command: 'command' in boot ? boot.command as string[] : undefined, evidence: boot as unknown as Record<string, unknown> },
    ));
    failRemaining(4, 'Skipped because simulator_preparation failed.');
    cleanupSimulator(false);
    return {
      ready: false, overallStatus, blockedStage, stages, artifacts, commands,
      discovery: discovered, schemes: schemesList, scheme: selectedScheme, build: buildResult, udid, boot,
      simulatorOwnership, cleanupPolicy, simulatorCleanup,
    };
  }
  stages.push(stagePassed('simulator_preparation', `Simulator ${udid} is booted.`, {
    command: 'command' in boot ? boot.command as string[] : undefined,
    evidence: {
      udid,
      alreadyBooted: 'alreadyBooted' in boot ? boot.alreadyBooted : undefined,
      ownership: simulatorOwnership,
      cleanupPolicy,
    },
  }));

  // 5. install
  const install = iosAppInstall(repository, { udid, appPath });
  if (!install.ready) {
    overallStatus = 'failed';
    blockedStage = 'install';
    stages.push(stageFailed(
      'install',
      ('error' in install && install.error ? String((install.error as { message?: string }).message) : 'Install failed'),
      'Confirm the .app path is under .repo-harness/ios/DerivedData and matches the simulator architecture.',
      { evidence: install as unknown as Record<string, unknown> },
    ));
    failRemaining(5, 'Skipped because install failed.');
    cleanupSimulator(false);
    return {
      ready: false, overallStatus, blockedStage, stages, artifacts, commands,
      discovery: discovered, schemes: schemesList, scheme: selectedScheme, build: buildResult, udid, boot, install,
      simulatorOwnership, cleanupPolicy, simulatorCleanup,
    };
  }
  stages.push(stagePassed('install', `Installed ${appPath} on ${udid}.`, {
    evidence: install as unknown as Record<string, unknown>,
  }));

  // 6. launch
  const bundleId = String(input.bundleId ?? readBuiltAppBundleId(repository, appPath) ?? '').trim();
  if (!bundleId) {
    overallStatus = 'failed';
    blockedStage = 'launch';
    stages.push(stageFailed(
      'launch',
      'Could not resolve CFBundleIdentifier for the built app.',
      'Pass bundle_id explicitly or ensure Info.plist contains CFBundleIdentifier.',
      { evidence: { appPath } },
    ));
    failRemaining(6, 'Skipped because launch failed.');
    cleanupSimulator(false);
    return {
      ready: false, overallStatus, blockedStage, stages, artifacts, commands,
      discovery: discovered, schemes: schemesList, scheme: selectedScheme, build: buildResult, udid, boot, install,
      simulatorOwnership, cleanupPolicy, simulatorCleanup,
    };
  }
  const launch = iosAppLaunch({ udid, bundleId, waitMs: input.launchWaitMs });
  if (!launch.ready) {
    overallStatus = 'failed';
    blockedStage = 'launch';
    stages.push(stageFailed(
      'launch',
      ('error' in launch && launch.error ? String((launch.error as { message?: string }).message) : 'Launch failed'),
      'Verify the bundle id, reinstall the app, and check Simulator console for crash logs.',
      { evidence: launch as unknown as Record<string, unknown> },
    ));
    failRemaining(6, 'Skipped because launch failed.');
    cleanupSimulator(false);
    return {
      ready: false, overallStatus, blockedStage, stages, artifacts, commands,
      discovery: discovered, schemes: schemesList, scheme: selectedScheme, build: buildResult,
      udid, bundleId, boot, install, launch, simulatorOwnership, cleanupPolicy, simulatorCleanup,
    };
  }
  stages.push(stagePassed('launch', `Launched ${bundleId} on ${udid}.`, {
    evidence: launch as unknown as Record<string, unknown>,
  }));

  // 7. screenshot
  const screenshot = iosSimulatorScreenshot(repository, {
    udid,
    label: input.screenshotLabel ?? selectedScheme,
    artifactRoot: input.artifactRoot,
  }) as {
    ready: boolean;
    screenshot?: string;
    absolutePath?: string;
    command?: string[];
    error?: { message?: string };
  };
  if (Array.isArray(screenshot.command)) commands.push(screenshot.command);
  if (screenshot.ready && screenshot.screenshot) artifacts.push(screenshot.screenshot);
  if (!screenshot.ready) {
    overallStatus = 'failed';
    blockedStage = 'screenshot';
    stages.push(stageFailed(
      'screenshot',
      screenshot.error?.message ?? 'Screenshot failed',
      'Ensure the simulator is booted and simctl io screenshot works for the selected udid.',
      { command: screenshot.command, evidence: screenshot as unknown as Record<string, unknown> },
    ));
    failRemaining(7, 'Skipped because screenshot failed.');
    // still attempt logs for diagnosis
  } else {
    stages.push(stagePassed('screenshot', `Captured screenshot ${screenshot.screenshot}.`, {
      command: screenshot.command,
      evidence: { screenshot: screenshot.screenshot, absolutePath: screenshot.absolutePath },
      artifacts: screenshot.screenshot ? [screenshot.screenshot] : undefined,
    }));
  }

  // 8. logs
  const logs = iosSimulatorLogTail(repository, {
    udid,
    process: selectedScheme,
    maxBytes: 12_000,
    artifactRoot: input.artifactRoot,
  }) as {
    ready: boolean;
    path?: string;
    content?: string;
    truncated?: boolean;
    command?: string[];
    error?: { message?: string };
  };
  if (Array.isArray(logs.command)) commands.push(logs.command);
  if (logs.path) artifacts.push(logs.path);
  if (!logs.ready) {
    if (overallStatus === 'passed') {
      overallStatus = 'failed';
      blockedStage = 'logs';
    }
    stages.push(stageFailed(
      'logs',
      logs.error?.message ?? 'Log collection failed',
      'Simulator may still be booting; retry log_tail after a few seconds.',
      { command: logs.command, evidence: { path: logs.path, truncated: logs.truncated }, artifacts: logs.path ? [logs.path] : undefined },
    ));
  } else {
    stages.push(stagePassed('logs', `Collected logs at ${logs.path}.`, {
      command: logs.command,
      evidence: { path: logs.path, truncated: logs.truncated, preview: logs.content?.slice(0, 500) },
      artifacts: logs.path ? [logs.path] : undefined,
    }));
  }

  const failed = stages.find((stage) => stage.status === 'failed');
  cleanupSimulator(overallStatus === 'passed');
  return {
    ready: overallStatus === 'passed',
    overallStatus,
    blockedStage: failed?.stage,
    blockedRepairHint: failed?.repairHint,
    stages,
    artifacts,
    commands,
    discovery: discovered,
    schemes: schemesList,
    scheme: selectedScheme,
    bundleId,
    udid,
    build: buildResult,
    boot,
    install,
    launch,
    screenshot,
    logs,
    simulatorOwnership,
    cleanupPolicy,
    simulatorCleanup,
  };
}

export function iosUiSmokeTest(repository: RepositoryRecord, input: { udid?: string; simulatorName?: string; scheme?: string; bundleId?: string; workspace?: string; project?: string; configuration?: string; appPath?: string; screenshotLabel?: string; launchWaitMs?: number; cleanupPolicy?: 'keep' | 'shutdown_on_success' | 'shutdown_always' }) {
  const review = iosSmokeReview(repository, input);
  return {
    ready: review.ready,
    udid: review.udid,
    scheme: review.scheme,
    bundleId: review.bundleId,
    build: review.build,
    install: review.install,
    boot: review.boot,
    launch: review.launch,
    screenshot: review.screenshot,
    logs: review.logs,
    stages: review.stages,
    overallStatus: review.overallStatus,
    blockedStage: review.blockedStage,
    artifacts: review.artifacts,
  };
}
