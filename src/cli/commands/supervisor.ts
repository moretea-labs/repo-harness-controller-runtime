import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { Command } from 'commander';
import { ensureControllerHome, resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import { bootstrapLaunchAgentWithRetry, installLaunchAgent, launchAgentPath, restoreLaunchAgent, snapshotLaunchAgent, type LaunchAgentFileSnapshot } from '../controller/launch-agents';
import { launchStableSupervisor } from '../../runtime/supervisor/bridge';
import { sendSupervisorCommand } from '../../runtime/supervisor/control-server';
import { installSupervisorRelease, startRegisteredSupervisorService, supervisorServiceLabel, supervisorSystemdUnitName } from '../../runtime/supervisor/installer';
import { isStableSupervisorInstalled, publishCurrentRelease, readCurrentRelease, readCurrentSupervisorRelease, readPreviousRelease, supervisorLogPath, supervisorRoot } from '../../runtime/supervisor/paths';
import { readSupervisorState } from '../../runtime/supervisor/state-store';
import { processIdentityMatches } from '../../runtime/supervisor/identity';
import { isProcessAlive, terminateProcessTree } from '../../runtime/shared/process-tree';
import { runProcess } from '../../effects/process-runner';
import { stopControllerService } from '../controller/lifecycle';
import { writeJsonAtomic } from '../../runtime/shared/json-files';

function output(value: unknown, json = true): void {
  console.log(json ? JSON.stringify(value, null, 2) : String(value));
}

function repoRoot(input?: string): string {
  return resolve(input ?? process.cwd());
}

function homeFor(repo: string, explicit?: string): string {
  return ensureControllerHome(resolveRepoPreferredControllerHome(repo, explicit));
}

function requestId(value?: string): string {
  return value?.trim() || `supervisor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function launchSupervisor(repo: string, home: string): { pid?: number; service?: Record<string, unknown> } {
  const service = startRegisteredSupervisorService(home);
  if (service.managed) return { service: service as unknown as Record<string, unknown> };
  return { pid: launchStableSupervisor({ repoRoot: repo, controllerHome: home, logPath: supervisorLogPath(home) }).pid, service: service as unknown as Record<string, unknown> };
}

function activationStatePath(home: string): string {
  return join(supervisorRoot(home), 'activation.json');
}

function writeActivationState(home: string, value: Record<string, unknown>): void {
  writeJsonAtomic(activationStatePath(home), { schemaVersion: 1, ...value, updatedAt: new Date().toISOString() });
}

export function supervisorActivationMatchesRelease(control: unknown, expectedReleaseRevision: string): boolean {
  if (!control || typeof control !== 'object') return false;
  const response = control as { ok?: unknown; state?: unknown };
  if (response.ok !== true || !response.state || typeof response.state !== 'object') return false;
  const state = response.state as {
    observedState?: unknown;
    supervisor?: { releaseRevision?: unknown };
    controllerDaemon?: { releaseRevision?: unknown };
    gatewayHost?: { releaseRevision?: unknown };
  };
  return state.observedState === 'healthy'
    && state.supervisor?.releaseRevision === expectedReleaseRevision
    && state.controllerDaemon?.releaseRevision === expectedReleaseRevision
    && state.gatewayHost?.releaseRevision === expectedReleaseRevision;
}

export function scheduleServiceActivation(
  repo: string,
  home: string,
  handoffDelayMs = 750,
): { activationId: string; pid: number; statePath: string; logPath: string } {
  const activationId = `sup-activate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const currentRelease = readCurrentRelease(home);
  const installedCli = currentRelease ? join(currentRelease, 'repo-harness.js') : undefined;
  const cliEntry = installedCli && existsSync(installedCli)
    ? installedCli
    : process.argv[1] ? resolve(process.argv[1]) : undefined;
  if (!cliEntry) throw new Error('SUPERVISOR_ACTIVATION_ENTRY_UNAVAILABLE');
  const logPath = join(supervisorRoot(home), 'logs', 'activation.log');
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [
      cliEntry,
      'supervisor',
      '__activate',
      '--repo', repo,
      '--controller-home', home,
      '--activation-id', activationId,
      '--handoff-delay-ms', String(Math.max(750, Math.min(Math.trunc(handoffDelayMs), 30_000))),
    ], {
      cwd: repo,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, REPO_HARNESS_CONTROLLER_HOME: home },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error('SUPERVISOR_ACTIVATION_SPAWN_FAILED');
  writeActivationState(home, { activationId, phase: 'scheduled', pid: child.pid, repoRoot: repo, startedAt: new Date().toISOString() });
  return { activationId, pid: child.pid, statePath: activationStatePath(home), logPath };
}

async function activateInstalledService(
  repo: string,
  home: string,
  activationId: string,
  handoffDelayMs = 750,
): Promise<Record<string, unknown>> {
  const update = (phase: string, extra: Record<string, unknown> = {}) => writeActivationState(home, { activationId, phase, repoRoot: repo, ...extra });
  const label = supervisorServiceLabel(home);
  const rollback: { previousReleasePath?: string; launchAgent: LaunchAgentFileSnapshot } = {
    previousReleasePath: readPreviousRelease(home),
    launchAgent: snapshotLaunchAgent(launchAgentPath(label)),
  };
  const expectedRelease = readCurrentSupervisorRelease(home);
  const expectedReleaseRevision = expectedRelease?.releaseRevision;
  try {
    if (!expectedRelease || !expectedReleaseRevision) throw new Error('SUPERVISOR_ACTIVATION_EXPECTED_RELEASE_UNAVAILABLE');
    update('waiting_for_handoff');
    await new Promise((resolveWait) => setTimeout(
      resolveWait,
      Math.max(750, Math.min(Math.trunc(handoffDelayMs), 30_000)),
    ));
    update('stopping_legacy');
    const stopped = await stopControllerService({
      repo,
      controllerHome: home,
      protectCallerAncestry: false,
      requireFullStop: true,
      stopTimeoutMs: 15_000,
    });
    update('registering_service', { stoppedAction: stopped.action, cleanedPids: stopped.cleanedPids });
    unregisterService(home);
    const service = await registerService(home);
    const deadline = Date.now() + 90_000;
    let control: unknown;
    while (Date.now() < deadline) {
      try {
        control = await sendSupervisorCommand(home, { command: 'status' });
        if (supervisorActivationMatchesRelease(control, expectedReleaseRevision)) break;
      } catch {
        // OS service startup is asynchronous.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    if (!supervisorActivationMatchesRelease(control, expectedReleaseRevision)) {
      throw new Error(`SUPERVISOR_ACTIVATION_VERIFY_TIMEOUT: expected releaseRevision=${expectedReleaseRevision}`);
    }
    update('succeeded', { completedAt: new Date().toISOString(), service });
    return { ok: true, activationId, stopped, service, control };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let recovery: Record<string, unknown> | undefined;
    try {
      recovery = await restorePreviousActivation(repo, home, rollback);
    } catch (recoveryError) {
      recovery = { ok: false, error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) };
    }
    update('failed', { completedAt: new Date().toISOString(), error: message.slice(0, 2_000), recovery });
    throw error;
  }
}

async function restorePreviousActivation(
  repo: string,
  home: string,
  rollback: { previousReleasePath?: string; launchAgent: LaunchAgentFileSnapshot },
): Promise<Record<string, unknown>> {
  try { unregisterService(home); } catch { /* recovery below may still use a detached Supervisor */ }
  const current = readCurrentRelease(home);
  const previous = rollback.previousReleasePath ?? readPreviousRelease(home);
  if (previous) publishCurrentRelease(home, previous, current);
  restoreLaunchAgent(rollback.launchAgent);

  if (process.platform === 'darwin' && rollback.launchAgent.content !== undefined) {
    const uid = typeof process.getuid === 'function'
      ? process.getuid()
      : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1_024 }).stdout.trim());
    try {
      const attempts = await bootstrapLaunchAgentWithRetry({
        label: supervisorServiceLabel(home),
        plistPath: rollback.launchAgent.path,
        domain: `gui/${uid}`,
      });
      return { ok: true, mode: 'previous_launch_agent', plistPath: rollback.launchAgent.path, bootstrapAttempts: attempts };
    } catch (error) {
      if (!previous) throw error;
      const launched = launchStableSupervisor({ repoRoot: repo, controllerHome: home, logPath: supervisorLogPath(home) });
      return {
        ok: true,
        mode: 'detached_previous_release_after_launch_agent_failure',
        pid: launched.pid,
        releasePath: previous,
        launchAgentError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (previous) {
    const launched = launchStableSupervisor({ repoRoot: repo, controllerHome: home, logPath: supervisorLogPath(home) });
    return { ok: true, mode: 'detached_previous_release', pid: launched.pid, releasePath: previous };
  }
  return { ok: false, reason: 'previous_release_and_launch_agent_unavailable' };
}

async function stopSupervisor(home: string): Promise<Record<string, unknown>> {
  try {
    const response = await sendSupervisorCommand(home, { command: 'stop' });
    return response as unknown as Record<string, unknown>;
  } catch (error) {
    const state = readSupervisorState(home);
    if (!state || state.desiredState === 'stopped' || !isProcessAlive(state.supervisor.pid)) return { ok: true, stopped: false, reason: 'not_running' };
    const match = processIdentityMatches(state.supervisor, state.supervisor.pid);
    if (!match.matches) throw new Error(`SUPERVISOR_STOP_IDENTITY_UNPROVEN: ${match.reason ?? 'unknown'}`);
    const result = await terminateProcessTree(state.supervisor.pid, { gracePeriodMs: 1_500, killAfterMs: 8_000 });
    return { ok: result.exited, stopped: result.exited, fallback: true };
  }
}

async function registerService(home: string): Promise<Record<string, unknown>> {
  const root = supervisorRoot(home);
  const launchd = join(root, 'launchd', `${supervisorServiceLabel(home)}.plist`);
  const systemdUnit = supervisorSystemdUnitName(home);
  const systemd = join(root, 'systemd', systemdUnit);
  if (process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1_024 }).stdout.trim());
    const label = supervisorServiceLabel(home);
    const installed = installLaunchAgent(launchd, label);
    const attempts = await bootstrapLaunchAgentWithRetry({ label, plistPath: installed.path, domain: `gui/${uid}` });
    return { platform: 'launchd', registered: true, plistPath: installed.path, bootstrapAttempts: attempts };
  }
  if (process.platform === 'linux') {
    const enabled = runProcess('systemctl', ['--user', 'enable', '--now', systemd], { timeoutMs: 15_000, maxOutputBytes: 20_000 });
    if (!enabled.ok) throw new Error(`SUPERVISOR_SYSTEMD_REGISTER_FAILED: ${enabled.stderr || enabled.stdout}`);
    return { platform: 'systemd', registered: true, unitPath: systemd };
  }
  return { platform: process.platform, registered: false, reason: 'unsupported_platform' };
}

function unregisterService(home: string): Record<string, unknown> {
  if (process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1_024 }).stdout.trim());
    const result = runProcess('launchctl', ['bootout', `gui/${uid}/${supervisorServiceLabel(home)}`], { timeoutMs: 15_000, maxOutputBytes: 20_000 });
    if (!result.ok && !/not found|no such process|could not be found/i.test(`${result.stderr}\n${result.stdout}`)) throw new Error(`SUPERVISOR_LAUNCHD_UNREGISTER_FAILED: ${result.stderr || result.stdout}`);
    return { platform: 'launchd', registered: false };
  }
  if (process.platform === 'linux') {
    const result = runProcess('systemctl', ['--user', 'disable', '--now', supervisorSystemdUnitName(home)], { timeoutMs: 15_000, maxOutputBytes: 20_000 });
    if (!result.ok && !/not found|disabled|not loaded/i.test(`${result.stderr}\n${result.stdout}`)) throw new Error(`SUPERVISOR_SYSTEMD_UNREGISTER_FAILED: ${result.stderr || result.stdout}`);
    return { platform: 'systemd', registered: false };
  }
  return { platform: process.platform, registered: false };
}

export function buildSupervisorCommand(): Command {
  const command = new Command('supervisor').description('Manage the stable controller-scoped external runtime Supervisor');

  command.command('__activate')
    .description('Internal detached handoff from the legacy lifecycle to the registered stable Supervisor')
    .requiredOption('--repo <path>')
    .requiredOption('--controller-home <path>')
    .requiredOption('--activation-id <id>')
    .option('--handoff-delay-ms <ms>', 'Delay before replacing the active Supervisor', '750')
    .action(async (opts: { repo: string; controllerHome: string; activationId: string; handoffDelayMs?: string }) => {
      const repo = repoRoot(opts.repo);
      const home = homeFor(repo, opts.controllerHome);
      output(await activateInstalledService(repo, home, opts.activationId, Number(opts.handoffDelayMs ?? 750)));
    });

  command.command('install')
    .description('Build and atomically install a stable Supervisor release')
    .option('--repo <path>', 'Repository root')
    .option('--controller-home <path>', 'Controller-scoped state root')
    .option('--source-root <path>', 'Controller runtime source root')
    .option('--register-service', 'Register launchd/systemd service after installing')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; controllerHome?: string; sourceRoot?: string; registerService?: boolean; json?: boolean }) => {
      const repo = repoRoot(opts.repo);
      const home = homeFor(repo, opts.controllerHome);
      const result = installSupervisorRelease({ controllerHome: home, repoRoot: repo, sourceRoot: opts.sourceRoot });
      const activation = opts.registerService ? scheduleServiceActivation(repo, home) : undefined;
      output({ ...result, ...(activation ? { activation, service: { registrationScheduled: true } } : {}) }, opts.json !== false);
    });

  command.command('uninstall')
    .description('Stop and unregister the stable Supervisor while retaining bounded release history')
    .option('--repo <path>', 'Repository root')
    .option('--controller-home <path>', 'Controller-scoped state root')
    .option('--json', 'Output JSON')
    .action(async (opts: { repo?: string; controllerHome?: string; json?: boolean }) => {
      const home = homeFor(repoRoot(opts.repo), opts.controllerHome);
      const stopped = await stopSupervisor(home);
      const service = unregisterService(home);
      rmSync(join(supervisorRoot(home), 'current'), { force: true });
      output({ stopped, service, installed: isStableSupervisorInstalled(home) }, opts.json !== false);
    });

  command.command('start')
    .description('Start the installed stable Supervisor')
    .option('--repo <path>', 'Repository root')
    .option('--controller-home <path>', 'Controller-scoped state root')
    .option('--json', 'Output JSON')
    .action(async (opts: { repo?: string; controllerHome?: string; json?: boolean }) => {
      const repo = repoRoot(opts.repo);
      const home = homeFor(repo, opts.controllerHome);
      if (!isStableSupervisorInstalled(home)) throw new Error('SUPERVISOR_NOT_INSTALLED: run repo-harness supervisor install first');
      const started = launchSupervisor(repo, home);
      output({ accepted: true, ...started, controllerHome: home, release: readCurrentRelease(home) }, opts.json !== false);
    });

  command.command('stop')
    .description('Stop the stable Supervisor and its managed business runtime')
    .option('--repo <path>', 'Repository root')
    .option('--controller-home <path>', 'Controller-scoped state root')
    .option('--json', 'Output JSON')
    .action(async (opts: { repo?: string; controllerHome?: string; json?: boolean }) => output(await stopSupervisor(homeFor(repoRoot(opts.repo), opts.controllerHome)), opts.json !== false));

  command.command('status')
    .description('Read stable Supervisor state and control-socket status')
    .option('--repo <path>', 'Repository root')
    .option('--controller-home <path>', 'Controller-scoped state root')
    .option('--json', 'Output JSON')
    .action(async (opts: { repo?: string; controllerHome?: string; json?: boolean }) => {
      const home = homeFor(repoRoot(opts.repo), opts.controllerHome);
      const state = readSupervisorState(home);
      let control: unknown;
      try { control = await sendSupervisorCommand(home, { command: 'status' }); } catch (error) { control = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      output({ installed: isStableSupervisorInstalled(home), state, control }, opts.json !== false);
    });

  command.command('logs')
    .description('Read bounded stable Supervisor logs')
    .option('--repo <path>', 'Repository root')
    .option('--controller-home <path>', 'Controller-scoped state root')
    .option('--tail <lines>', 'Approximate line count', '200')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; controllerHome?: string; tail?: string; json?: boolean }) => {
      const path = supervisorLogPath(homeFor(repoRoot(opts.repo), opts.controllerHome));
      let text = '';
      try { text = readFileSync(path, 'utf8').split('\n').slice(-Math.max(1, Number(opts.tail ?? 200))).join('\n'); } catch { /* no log yet */ }
      output({ logPath: path, text }, opts.json !== false);
    });

  const restart = command.command('restart').description('Submit one durable component restart operation');
  for (const component of ['controller', 'gateway', 'full'] as const) {
    restart.command(component)
      .option('--repo <path>', 'Repository root')
      .option('--controller-home <path>', 'Controller-scoped state root')
      .option('--request-id <id>', 'Idempotency key')
      .option('--reason <text>', 'Bounded reason')
      .option('--json', 'Output JSON')
      .action(async (opts: { repo?: string; controllerHome?: string; requestId?: string; reason?: string; json?: boolean }) => {
        const home = homeFor(repoRoot(opts.repo), opts.controllerHome);
        const response = await sendSupervisorCommand(home, { command: 'operation_submit', requestId: requestId(opts.requestId), kind: `restart_${component}` as 'restart_controller' | 'restart_gateway' | 'restart_full', actor: 'supervisor-cli', reason: opts.reason });
        output(response, opts.json !== false);
      });
  }

  for (const kind of ['rollout', 'rollback', 'unlock-and-recover'] as const) {
    command.command(kind)
      .option('--repo <path>', 'Repository root')
      .option('--controller-home <path>', 'Controller-scoped state root')
      .option('--request-id <id>', 'Idempotency key')
      .option('--reason <text>', 'Bounded reason')
      .option('--json', 'Output JSON')
      .action(async (opts: { repo?: string; controllerHome?: string; requestId?: string; reason?: string; json?: boolean }) => {
        const home = homeFor(repoRoot(opts.repo), opts.controllerHome);
        const operation = kind === 'unlock-and-recover' ? 'unlock_and_recover' : kind;
        const response = await sendSupervisorCommand(home, { command: 'operation_submit', requestId: requestId(opts.requestId), kind: operation as 'rollout' | 'rollback' | 'unlock_and_recover', actor: 'supervisor-cli', reason: opts.reason });
        output(response, opts.json !== false);
      });
  }

  command.command('operation')
    .description('Read one durable operation')
    .argument('<operation-id>', 'Supervisor operation ID')
    .option('--repo <path>', 'Repository root')
    .option('--controller-home <path>', 'Controller-scoped state root')
    .option('--json', 'Output JSON')
    .action(async (operationId: string, opts: { repo?: string; controllerHome?: string; json?: boolean }) => {
      const home = homeFor(repoRoot(opts.repo), opts.controllerHome);
      const response = await sendSupervisorCommand(home, { command: 'operation_get', operationId });
      output(response, opts.json !== false);
    });

  return command;
}
