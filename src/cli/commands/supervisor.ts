import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Command } from 'commander';
import { ensureControllerHome, resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import { installLaunchAgent, launchAgentPath, restoreLaunchAgent, snapshotLaunchAgent, safeLaunchdHandoff, type LaunchAgentFileSnapshot, type LaunchdServiceProbe, type LaunchctlCommandRunner } from '../controller/launch-agents';
import { launchStableSupervisor } from '../../runtime/supervisor/bridge';
import { sendSupervisorCommand } from '../../runtime/supervisor/control-server';
import { stageSupervisorRelease, startRegisteredSupervisorService, supervisorServiceLabel, supervisorSystemdUnitName } from '../../runtime/supervisor/installer';
import { isStableSupervisorInstalled, publishCurrentRelease, readCurrentRelease, readCurrentSupervisorRelease, supervisorLogPath, supervisorRoot } from '../../runtime/supervisor/paths';
import { extractSupervisorServiceRelease, readSupervisorServiceReleaseCoherence, type SupervisorServiceReleaseCoherence, type SupervisorServiceReleaseDescriptor } from '../../runtime/supervisor/release-coherence';
import { readSupervisorState } from '../../runtime/supervisor/state-store';
import { processIdentityMatches } from '../../runtime/supervisor/identity';
import { isProcessAlive, terminateProcessTree } from '../../runtime/shared/process-tree';
import { runProcess } from '../../effects/process-runner';
import { stopControllerService } from '../controller/lifecycle';
import { writeJsonAtomic } from '../../runtime/shared/json-files';
import {
  publishAndScheduleSupervisorRelease,
  readServiceActivationState as readRuntimeServiceActivationState,
  scheduleServiceActivation as scheduleRuntimeServiceActivation,
  serviceActivationStatePath as runtimeServiceActivationStatePath,
  waitForServiceActivation as waitForRuntimeServiceActivation,
  type SupervisorActivationPhase as RuntimeSupervisorActivationPhase,
  type SupervisorActivationState as RuntimeSupervisorActivationState,
} from '../../runtime/supervisor/service-activation';
import {
  initActivationState,
  transitionPhase,
  failActivation,
  resolveExistingActivation,
  hasCompletedPhase,
  type ActivationPhase,
  type ActivationStateRecord,
} from '../../runtime/supervisor/activation-state-machine';

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

export type SupervisorActivationPhase = RuntimeSupervisorActivationPhase;
export type SupervisorActivationState = RuntimeSupervisorActivationState;

export function serviceActivationStatePath(home: string): string {
  return runtimeServiceActivationStatePath(home);
}

export const readServiceActivationState = readRuntimeServiceActivationState;

function writeActivationState(home: string, value: Record<string, unknown>): void {
  const existing = readServiceActivationState(home);
  writeJsonAtomic(serviceActivationStatePath(home), {
    ...(existing ?? {}),
    schemaVersion: 1,
    ...value,
    updatedAt: new Date().toISOString(),
  });
}

export const waitForServiceActivation = waitForRuntimeServiceActivation;

export function supervisorActivationMatchesRelease(
  control: unknown,
  expectedReleaseRevision: string,
  serviceCoherence?: SupervisorServiceReleaseCoherence,
): boolean {
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
    && state.gatewayHost?.releaseRevision === expectedReleaseRevision
    && serviceCoherence?.ok !== false;
}

export function selectSupervisorRollbackRelease(input: {
  running?: SupervisorServiceReleaseDescriptor;
  installed?: SupervisorServiceReleaseDescriptor;
  current?: SupervisorServiceReleaseDescriptor;
}): SupervisorServiceReleaseDescriptor | undefined {
  const candidates = [input.running, input.installed, input.current];
  return candidates.find((candidate) => Boolean(candidate?.releasePath && candidate.releaseRevision));
}

export function scheduleServiceActivation(
  repo: string,
  home: string,
  handoffDelayMs = 750,
) {
  return scheduleRuntimeServiceActivation(repo, home, handoffDelayMs);
}

/**
 * Verify the full readiness chain: ingress → active Gateway → public endpoint.
 * Only returns true when the complete path is healthy.
 */
async function verifyFullReadiness(
  home: string,
  expectedReleaseRevision: string,
  deadline: number,
): Promise<{ healthy: boolean; control?: unknown; serviceCoherence?: SupervisorServiceReleaseCoherence; error?: string }> {
  while (Date.now() < deadline) {
    try {
      const control = await sendSupervisorCommand(home, { command: 'status' });
      const controlState = control && typeof control === 'object' && (control as { state?: unknown }).state
        ? (control as { state: unknown }).state
        : readSupervisorState(home);
      const serviceCoherence = readSupervisorServiceReleaseCoherence(home, controlState as ReturnType<typeof readSupervisorState>);
      if (supervisorActivationMatchesRelease(control, expectedReleaseRevision, serviceCoherence)) {
        return { healthy: true, control, serviceCoherence };
      }
    } catch {
      // OS service startup is asynchronous — keep polling
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return { healthy: false, error: 'readiness deadline exceeded' };
}

/**
 * Verify that a detached Supervisor process is actually alive AND serving
 * the stable endpoint — not just that a PID was returned.
 */
async function verifyDetachedSupervisorHealth(
  home: string,
  pid: number,
  expectedReleaseRevision: string,
  deadlineMs = 60_000,
): Promise<{ healthy: boolean; error?: string }> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return { healthy: false, error: `detached supervisor pid=${pid} is no longer alive` };
    }
    try {
      const control = await sendSupervisorCommand(home, { command: 'status' });
      const controlState = control && typeof control === 'object' && (control as { state?: unknown }).state
        ? (control as { state: unknown }).state
        : readSupervisorState(home);
      const serviceCoherence = readSupervisorServiceReleaseCoherence(home, controlState as ReturnType<typeof readSupervisorState>);
      if (supervisorActivationMatchesRelease(control, expectedReleaseRevision, serviceCoherence)) {
        // Hold the observation for a bounded stability window
        const stabilityDeadline = Date.now() + 5_000;
        let stable = true;
        while (Date.now() < stabilityDeadline) {
          if (!isProcessAlive(pid)) { stable = false; break; }
          await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        }
        if (stable) return { healthy: true };
      }
    } catch {
      // Supervisor may still be starting
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return { healthy: false, error: 'detached supervisor did not become healthy within deadline' };
}

async function activateInstalledService(
  repo: string,
  home: string,
  activationId: string,
  handoffDelayMs = 750,
): Promise<Record<string, unknown>> {
  // Check idempotency — if this activation already completed, return immediately
  const existing = resolveExistingActivation(home, activationId);
  if (existing) {
    return {
      ok: existing.phase === 'succeeded',
      activationId,
      phase: existing.phase,
      idempotent: true,
      error: existing.error,
    };
  }

  const label = supervisorServiceLabel(home);
  const launchAgent = snapshotLaunchAgent(launchAgentPath(label));
  const generatedServicePath = join(supervisorRoot(home), 'launchd', `${label}.plist`);
  const runningState = readSupervisorState(home);
  const installedDescriptor = extractSupervisorServiceRelease(launchAgent.content?.toString('utf8'));
  const rollback: { release?: SupervisorServiceReleaseDescriptor; launchAgent: LaunchAgentFileSnapshot; generatedServicePath: string } = {
    release: selectSupervisorRollbackRelease({
      running: runningState?.supervisor.releasePath && runningState.supervisor.releaseRevision
        ? { releasePath: runningState.supervisor.releasePath, releaseRevision: runningState.supervisor.releaseRevision }
        : undefined,
      installed: installedDescriptor?.releasePath && installedDescriptor.releaseRevision
        ? { releasePath: installedDescriptor.releasePath, releaseRevision: installedDescriptor.releaseRevision }
        : undefined,
      current: readCurrentSupervisorRelease(home),
    }),
    launchAgent,
    generatedServicePath,
  };
  const expectedRelease = readCurrentSupervisorRelease(home);
  const expectedReleaseRevision = expectedRelease?.releaseRevision;
  if (!expectedRelease || !expectedReleaseRevision) {
    throw new Error('SUPERVISOR_ACTIVATION_EXPECTED_RELEASE_UNAVAILABLE');
  }

  // Initialize the state machine
  initActivationState({
    home,
    activationId,
    repoRoot: repo,
    expectedReleaseRevision,
    expectedReleasePath: expectedRelease.releasePath,
    previousReleaseRevision: rollback.release?.releaseRevision,
    previousReleasePath: rollback.release?.releasePath,
    serviceLabel: label,
    plistPath: launchAgent.path,
  });

  try {
    // Phase: stopping_previous
    transitionPhase(home, activationId, 'stopping_previous');
    await new Promise((resolveWait) => setTimeout(
      resolveWait,
      Math.max(750, Math.min(Math.trunc(handoffDelayMs), 30_000)),
    ));
    const stopped = await stopControllerService({
      repo,
      controllerHome: home,
      protectCallerAncestry: false,
      requireFullStop: true,
      stopTimeoutMs: 15_000,
    });

    // Phase: waiting_previous_exit
    transitionPhase(home, activationId, 'waiting_previous_exit', {
      oldPid: runningState?.supervisor.pid,
    });
    if (runningState?.supervisor.pid) {
      const exitDeadline = Date.now() + 15_000;
      while (Date.now() < exitDeadline) {
        if (!isProcessAlive(runningState.supervisor.pid)) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
    }

    // Phase: installing_service (includes safe bootout + bootstrap)
    transitionPhase(home, activationId, 'installing_service', {
      stoppedAction: stopped.action,
      cleanedPids: stopped.cleanedPids,
    });

    // Unregister old service (treat "not found" as success)
    unregisterService(home);

    // Install the plist atomically
    const launchdPlistPath = join(supervisorRoot(home), 'launchd', `${label}.plist`);
    const installed = installLaunchAgent(launchdPlistPath, label);

    const uid = typeof process.getuid === 'function'
      ? process.getuid()
      : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1_024 }).stdout.trim());

    // Phase: bootstrapping — use the safe state-driven handoff
    transitionPhase(home, activationId, 'bootstrapping');
    const handoffResult = await safeLaunchdHandoff({
      label,
      plistPath: installed.path,
      domain: `gui/${uid}`,
      oldPid: runningState?.supervisor.pid,
      port: 8765,
      maxBootoutWaitMs: 15_000,
      maxBootstrapRetry: 3,
      bootstrapRetryDelayMs: 500,
      pollIntervalMs: 200,
    });

    if (!handoffResult.serviceRegistered) {
      throw new Error(
        `SUPERVISOR_LAUNCHD_BOOTSTRAP_FAILED: ${handoffResult.bootstrapAttempts} attempts; ` +
        `bootoutClean=${handoffResult.bootoutClean} pidWaitClean=${handoffResult.pidWaitClean} portWaitClean=${handoffResult.portWaitClean}; ` +
        `lastError=${handoffResult.diagnostics.bootstrapResults[handoffResult.diagnostics.bootstrapResults.length - 1]?.stderr ?? 'unknown'}`,
      );
    }

    // Phase: waiting_service_registration
    transitionPhase(home, activationId, 'waiting_service_registration', {
      bootstrapAttempt: handoffResult.bootstrapAttempts,
    });
    const regDeadline = Date.now() + 10_000;
    while (Date.now() < regDeadline) {
      const checkResult = runProcess('launchctl', ['print', `gui/${uid}/${label}`], { timeoutMs: 3_000, maxOutputBytes: 8_192 });
      if (checkResult.ok) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }

    // Phase: waiting_supervisor_ready
    transitionPhase(home, activationId, 'waiting_supervisor_ready', {
      newPid: undefined, // will be discovered via control socket
    });

    // Phase: waiting_stable_endpoint — verify the full chain
    transitionPhase(home, activationId, 'waiting_stable_endpoint');
    const verifyDeadline = Date.now() + 90_000;
    const verifyResult = await verifyFullReadiness(home, expectedReleaseRevision, verifyDeadline);

    if (!verifyResult.healthy) {
      throw new Error(
        `SUPERVISOR_ACTIVATION_VERIFY_TIMEOUT: expected releaseRevision=${expectedReleaseRevision}; ` +
        `${verifyResult.error ?? 'endpoint not healthy'}`,
      );
    }

    // Phase: succeeded
    transitionPhase(home, activationId, 'succeeded', {
      readinessResult: {
        control: verifyResult.control,
        serviceCoherence: verifyResult.serviceCoherence,
      },
    });

    // Also write the legacy-format fields for backward compatibility
    writeActivationState(home, {
      phase: 'succeeded',
      completedAt: new Date().toISOString(),
      service: { platform: 'launchd', registered: true, plistPath: installed.path, bootstrapAttempts: handoffResult.bootstrapAttempts },
      releaseRevision: expectedRelease.releaseRevision,
      releasePath: expectedRelease.releasePath,
      serviceCoherence: verifyResult.serviceCoherence,
    });

    return {
      ok: true,
      activationId,
      stopped,
      service: { platform: 'launchd', registered: true, plistPath: installed.path, bootstrapAttempts: handoffResult.bootstrapAttempts },
      control: verifyResult.control,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Phase: rolling_back
    transitionPhase(home, activationId, 'rolling_back', { error: message });
    let recovery: Record<string, unknown>;
    try {
      recovery = await restorePreviousActivation(repo, home, rollback);
    } catch (recoveryError) {
      recovery = { ok: false, error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) };
    }

    // Phase: failed
    failActivation(home, activationId, message.slice(0, 2_000), recovery);

    writeActivationState(home, {
      phase: 'failed',
      completedAt: new Date().toISOString(),
      error: message.slice(0, 2_000),
      recovery,
    });

    throw error;
  }
}

/**
 * Restore the previous activation with FULL endpoint verification.
 * A detached PID is not sufficient — the ingress must be bound and the
 * complete ready path must succeed.
 */
async function restorePreviousActivation(
  repo: string,
  home: string,
  rollback: { release?: SupervisorServiceReleaseDescriptor; launchAgent: LaunchAgentFileSnapshot; generatedServicePath: string },
): Promise<Record<string, unknown>> {
  try { unregisterService(home); } catch { /* recovery below may still use a detached Supervisor */ }
  const current = readCurrentRelease(home);
  const previous = rollback.release?.releasePath;
  if (previous) publishCurrentRelease(home, previous, current);
  restoreLaunchAgent(rollback.launchAgent);

  if (process.platform === 'darwin' && rollback.launchAgent.content !== undefined) {
    mkdirSync(dirname(rollback.generatedServicePath), { recursive: true, mode: 0o700 });
    writeFileSync(rollback.generatedServicePath, rollback.launchAgent.content, { mode: 0o600 });
    const uid = typeof process.getuid === 'function'
      ? process.getuid()
      : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1_024 }).stdout.trim());

    try {
      const handoffResult = await safeLaunchdHandoff({
        label: supervisorServiceLabel(home),
        plistPath: rollback.launchAgent.path,
        domain: `gui/${uid}`,
        maxBootoutWaitMs: 10_000,
        maxBootstrapRetry: 3,
        bootstrapRetryDelayMs: 500,
      });

      if (handoffResult.serviceRegistered) {
        // Verify the previous release actually comes up healthy
        if (rollback.release?.releaseRevision) {
          const verifyDeadline = Date.now() + 60_000;
          const verifyResult = await verifyFullReadiness(home, rollback.release.releaseRevision, verifyDeadline);
          if (verifyResult.healthy) {
            return { ok: true, mode: 'previous_launch_agent', plistPath: rollback.launchAgent.path, bootstrapAttempts: handoffResult.bootstrapAttempts, release: rollback.release, serviceCoherence: verifyResult.serviceCoherence };
          }
          // Endpoint verification failed — fall through to detached fallback
        }
      }
    } catch {
      // LaunchAgent bootstrap failed — fall through to detached fallback
    }
  }

  // Detached fallback — ONLY as short-term rescue, and MUST verify health
  if (previous && rollback.release?.releaseRevision) {
    const launched = launchStableSupervisor({ repoRoot: repo, controllerHome: home, logPath: supervisorLogPath(home) });

    // CRITICAL: verify the detached supervisor actually becomes healthy
    const healthResult = await verifyDetachedSupervisorHealth(home, launched.pid, rollback.release.releaseRevision, 60_000);

    if (healthResult.healthy) {
      return {
        ok: true,
        mode: 'detached_previous_release',
        pid: launched.pid,
        releasePath: previous,
      };
    }

    // Detached supervisor failed health check — this is a real failure
    return {
      ok: false,
      mode: 'detached_previous_release_health_check_failed',
      pid: launched.pid,
      releasePath: previous,
      error: healthResult.error ?? 'detached supervisor did not become healthy',
    };
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
    const handoffResult = await safeLaunchdHandoff({
      label,
      plistPath: installed.path,
      domain: `gui/${uid}`,
      maxBootstrapRetry: 3,
    });
    return { platform: 'launchd', registered: handoffResult.serviceRegistered, plistPath: installed.path, bootstrapAttempts: handoffResult.bootstrapAttempts };
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
    .option('--register-service', 'Compatibility flag; service activation is now the safe default')
    .option('--stage-only', 'Build an immutable candidate without publishing current or changing the registered service')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; controllerHome?: string; sourceRoot?: string; registerService?: boolean; stageOnly?: boolean; json?: boolean }) => {
      const repo = repoRoot(opts.repo);
      const home = homeFor(repo, opts.controllerHome);
      if (opts.stageOnly) {
        const staged = stageSupervisorRelease({ controllerHome: home, repoRoot: repo, sourceRoot: opts.sourceRoot });
        output({ ...staged, stagedOnly: true, service: { registrationScheduled: false } }, opts.json !== false);
        return;
      }
      const staged = stageSupervisorRelease({ controllerHome: home, repoRoot: repo, sourceRoot: opts.sourceRoot });
      const { publication, activation } = publishAndScheduleSupervisorRelease({
        controllerHome: home,
        repoRoot: repo,
        releasePath: staged.releasePath,
      });
      output({ ...publication, activation, service: { registrationScheduled: true } }, opts.json !== false);
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
