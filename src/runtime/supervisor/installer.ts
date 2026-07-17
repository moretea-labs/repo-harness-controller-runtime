import { createHash } from 'crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';
import { resolveControllerRuntimeSourceRoot } from '../control-plane/runtime-generation';
import { readCurrentRelease, ensureStableSupervisorLayout, publishCurrentRelease, supervisorLogsRoot, supervisorReleasesRoot, supervisorRoot } from './paths';

export interface SupervisorInstallResult {
  controllerHome: string;
  releaseRevision: string;
  releasePath: string;
  currentPath: string;
  previousPath?: string;
  launchdPlistPath: string;
  systemdUnitPath: string;
}

function runtimeSourceRoot(explicit?: string): string {
  const resolved = resolveControllerRuntimeSourceRoot({ explicitRoot: explicit });
  if (!resolved.root) throw new Error(`SUPERVISOR_RUNTIME_SOURCE_UNAVAILABLE: ${resolved.detail ?? resolved.reason}`);
  return resolved.root;
}

function gitRevision(root: string): string {
  const revision = runProcess('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { timeoutMs: 10_000, maxOutputBytes: 4_096 });
  if (!revision.ok || !revision.stdout.trim()) return `local-${Date.now()}`;
  const dirty = runProcess('git', ['-C', root, 'status', '--porcelain=v1', '--', 'src', 'scripts', 'package.json', 'bun.lock'], { timeoutMs: 10_000, maxOutputBytes: 4_096 });
  return `${revision.stdout.trim()}${dirty.stdout.trim() ? '-dirty' : ''}`;
}

function buildEntry(sourceRoot: string, entry: string, output: string): void {
  const bun = process.versions.bun ? process.execPath : 'bun';
  const result = runProcess(bun, ['build', join(sourceRoot, entry), '--outfile', output, '--target', 'bun'], {
    cwd: sourceRoot,
    timeoutMs: 180_000,
    maxOutputBytes: 128 * 1024,
  });
  if (!result.ok) throw new Error(`SUPERVISOR_RELEASE_BUILD_FAILED: ${result.stderr || result.stdout}`.slice(0, 2_000));
}

function serviceSuffix(controllerHome: string): string {
  const normalized = resolve(controllerHome);
  const readable = normalized.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-28) || 'default';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `${readable}-${digest}`;
}

function serviceLabel(controllerHome: string): string {
  return `com.repo-harness.supervisor.${serviceSuffix(controllerHome)}`;
}

export function supervisorSystemdUnitName(controllerHome: string): string {
  return `repo-harness-supervisor-${serviceSuffix(controllerHome)}.service`;
}

function systemdQuote(value: string): string {
  return JSON.stringify(value);
}
export function renderLaunchdSupervisorPlist(input: {
  label: string;
  bunPath: string;
  supervisorPath: string;
  repoRoot: string;
  controllerHome: string;
  runtimeSourceRoot: string;
  releaseRevision?: string;
  logPath: string;
}): string {
  const args = [input.bunPath, input.supervisorPath, '--repo', input.repoRoot, '--controller-home', input.controllerHome, '--runtime-source-root', input.runtimeSourceRoot];
  if (input.releaseRevision) args.push('--release-revision', input.releaseRevision);
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(input.label)}</string>\n  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>2</integer>\n  <key>ProcessType</key><string>Interactive</string>\n  <key>StandardOutPath</key><string>${xml(input.logPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(input.logPath)}</string>\n</dict></plist>\n`;
}

export function renderSystemdSupervisorUnit(input: {
  bunPath: string;
  supervisorPath: string;
  repoRoot: string;
  controllerHome: string;
  runtimeSourceRoot: string;
}): string {
  const args = [input.bunPath, input.supervisorPath, '--repo', input.repoRoot, '--controller-home', input.controllerHome, '--runtime-source-root', input.runtimeSourceRoot];
  return `[Unit]\nDescription=repo-harness Stable External Runtime Supervisor\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${args.map(systemdQuote).join(' ')}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
}

export function installSupervisorRelease(input: { controllerHome: string; repoRoot: string; sourceRoot?: string }): SupervisorInstallResult {
  const controllerHome = resolve(input.controllerHome);
  const sourceRoot = runtimeSourceRoot(input.sourceRoot ?? input.repoRoot);
  ensureStableSupervisorLayout(controllerHome);
  const revision = gitRevision(sourceRoot);
  const releasePath = join(supervisorReleasesRoot(controllerHome), `${Date.now()}-${revision.replace(/[^a-zA-Z0-9._-]/g, '-')}`);
  mkdirSync(releasePath, { recursive: true, mode: 0o700 });
  buildEntry(sourceRoot, 'src/runtime/supervisor/entry.ts', join(releasePath, 'supervisor.js'));
  buildEntry(sourceRoot, 'src/cli/index.ts', join(releasePath, 'repo-harness.js'));
  buildEntry(sourceRoot, 'src/runtime/control-plane/daemon-entry.ts', join(releasePath, 'daemon.js'));
  writeFileSync(join(releasePath, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, releaseRevision: revision, sourceRoot, builtAt: new Date().toISOString(), entrypoint: 'supervisor.js', runtimeEntrypoint: 'repo-harness.js', daemonEntrypoint: 'daemon.js' }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(join(releasePath, 'supervisor.js'), 0o700); } catch { /* best effort */ }

  const previous = readCurrentRelease(controllerHome);
  publishCurrentRelease(controllerHome, releasePath, previous);
  const bunPath = process.versions.bun ? process.execPath : 'bun';
  const supervisorPath = join(releasePath, 'supervisor.js');
  const label = serviceLabel(controllerHome);
  const launchdDir = join(supervisorRoot(controllerHome), 'launchd');
  const systemdDir = join(supervisorRoot(controllerHome), 'systemd');
  mkdirSync(launchdDir, { recursive: true, mode: 0o700 });
  mkdirSync(systemdDir, { recursive: true, mode: 0o700 });
  const launchdPlistPath = join(launchdDir, `${label}.plist`);
  const systemdUnitPath = join(systemdDir, supervisorSystemdUnitName(controllerHome));
  writeFileSync(launchdPlistPath, renderLaunchdSupervisorPlist({ label, bunPath, supervisorPath, repoRoot: resolve(input.repoRoot), controllerHome, runtimeSourceRoot: sourceRoot, releaseRevision: revision, logPath: join(supervisorLogsRoot(controllerHome), 'launchd.log') }), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(systemdUnitPath, renderSystemdSupervisorUnit({ bunPath, supervisorPath, repoRoot: resolve(input.repoRoot), controllerHome, runtimeSourceRoot: sourceRoot }), { encoding: 'utf8', mode: 0o600 });
  return {
    controllerHome,
    releaseRevision: revision,
    releasePath,
    currentPath: join(supervisorRoot(controllerHome), 'current'),
    ...(previous ? { previousPath: previous } : {}),
    launchdPlistPath,
    systemdUnitPath,
  };
}

export function supervisorServiceLabel(controllerHome: string): string {
  return serviceLabel(controllerHome);
}


export interface SupervisorRegisteredServiceStartResult {
  managed: boolean;
  platform: string;
  target?: string;
  reason?: string;
}

function currentUserId(): number | undefined {
  if (typeof process.getuid === 'function') return process.getuid();
  const result = runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1_024 });
  const value = Number(result.stdout.trim());
  return result.ok && Number.isInteger(value) ? value : undefined;
}

/** Start an already-loaded OS service without creating a second detached owner. */
export function startRegisteredSupervisorService(controllerHome: string): SupervisorRegisteredServiceStartResult {
  if (process.platform === 'darwin') {
    const uid = currentUserId();
    if (uid === undefined) return { managed: false, platform: 'launchd', reason: 'uid_unavailable' };
    const target = `gui/${uid}/${serviceLabel(controllerHome)}`;
    const loaded = runProcess('launchctl', ['print', target], { timeoutMs: 5_000, maxOutputBytes: 8_192 });
    if (!loaded.ok) return { managed: false, platform: 'launchd', target, reason: 'not_loaded' };
    const started = runProcess('launchctl', ['kickstart', target], { timeoutMs: 15_000, maxOutputBytes: 20_000 });
    if (!started.ok && !/already|in progress/i.test(`${started.stderr}\n${started.stdout}`)) {
      throw new Error(`SUPERVISOR_LAUNCHD_START_FAILED: ${started.stderr || started.stdout}`);
    }
    return { managed: true, platform: 'launchd', target };
  }
  if (process.platform === 'linux') {
    const unit = supervisorSystemdUnitName(controllerHome);
    const loaded = runProcess('systemctl', ['--user', 'is-enabled', unit], { timeoutMs: 5_000, maxOutputBytes: 8_192 });
    if (!loaded.ok) return { managed: false, platform: 'systemd', target: unit, reason: 'not_enabled' };
    const started = runProcess('systemctl', ['--user', 'start', unit], { timeoutMs: 15_000, maxOutputBytes: 20_000 });
    if (!started.ok) throw new Error(`SUPERVISOR_SYSTEMD_START_FAILED: ${started.stderr || started.stdout}`);
    return { managed: true, platform: 'systemd', target: unit };
  }
  return { managed: false, platform: process.platform, reason: 'unsupported_platform' };
}
