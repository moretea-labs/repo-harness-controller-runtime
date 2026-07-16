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

function serviceLabel(controllerHome: string): string {
  const safe = controllerHome.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-48) || 'default';
  return `com.repo-harness.supervisor.${safe}`;
}

export function renderLaunchdSupervisorPlist(input: {
  label: string;
  bunPath: string;
  supervisorPath: string;
  repoRoot: string;
  controllerHome: string;
  runtimeSourceRoot: string;
  logPath: string;
}): string {
  const args = [input.bunPath, input.supervisorPath, '--repo', input.repoRoot, '--controller-home', input.controllerHome, '--runtime-source-root', input.runtimeSourceRoot];
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(input.label)}</string>\n  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Interactive</string>\n  <key>StandardOutPath</key><string>${xml(input.logPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(input.logPath)}</string>\n</dict></plist>\n`;
}

export function renderSystemdSupervisorUnit(input: {
  bunPath: string;
  supervisorPath: string;
  repoRoot: string;
  controllerHome: string;
  runtimeSourceRoot: string;
}): string {
  return `[Unit]\nDescription=repo-harness Stable External Runtime Supervisor\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${input.bunPath} ${input.supervisorPath} --repo ${input.repoRoot} --controller-home ${input.controllerHome} --runtime-source-root ${input.runtimeSourceRoot}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
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
  const systemdUnitPath = join(systemdDir, 'repo-harness-supervisor.service');
  writeFileSync(launchdPlistPath, renderLaunchdSupervisorPlist({ label, bunPath, supervisorPath, repoRoot: resolve(input.repoRoot), controllerHome, runtimeSourceRoot: sourceRoot, logPath: join(supervisorLogsRoot(controllerHome), 'launchd.log') }), { encoding: 'utf8', mode: 0o600 });
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
