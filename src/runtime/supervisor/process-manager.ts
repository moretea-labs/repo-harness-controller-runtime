import { closeSync, mkdirSync, openSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { loadLocalBridgeConfig } from '../../cli/local-bridge/job-store';
import { loadMcpServiceLocalConfig } from '../../cli/mcp/auth';
import { ensureSlotHome, readActiveSlotAuthority, readSlotIdentity, type RuntimeSlotId } from '../../cli/controller/runtime-slots';
import { readWriterAuthority } from '../../cli/controller/stable-state/writer-authority';
import { terminateProcessTree } from '../shared/process-tree';
import { captureProcessIdentity, defaultProcessIdentityProbe, executableFingerprint, newProcessInstanceId, processIdentityMatches, type ProcessIdentityProbe } from './identity';
import type { ProcessIdentity, SupervisorComponentName } from './types';

export interface SupervisorProcessManagerOptions {
  repoRoot: string;
  controllerHome: string;
  ownerEpoch: number;
  runtimeSourceRoot: string;
  runtimeExecutable?: string;
  daemonExecutable?: string;
  releasePath?: string;
  releaseRevision?: string;
  logPath: string;
  stableIngressHost?: string;
  stableIngressPort?: number;
  gatewayPortOffset?: number;
  slot?: RuntimeSlotId;
  identityProbe?: ProcessIdentityProbe;
}

export interface SpawnedSupervisorProcess {
  identity: ProcessIdentity;
  child?: ChildProcess;
  command: string;
  args: string[];
  component: SupervisorComponentName;
  home: string;
}

export type ProcessObservation = 'alive' | 'dead' | 'unknown';

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function configuredRuntimeSourceRoot(input: string): string {
  return resolve(input);
}

function componentHome(baseHome: string, slot: RuntimeSlotId | undefined, explicitSlot = false): string {
  if (!slot) return resolve(baseHome);
  const identity = readSlotIdentity(baseHome, slot);
  if (identity?.slotHome) return resolve(identity.slotHome);
  return explicitSlot ? ensureSlotHome(baseHome, slot) : resolve(baseHome);
}

function processCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

export function runtimeWriterEnvironment(controllerHome: string, slot: RuntimeSlotId): NodeJS.ProcessEnv {
  const authority = readWriterAuthority(controllerHome);
  if (!authority) return {};
  // Passive candidates still need a complete inherited claim so they can boot
  // and serve readiness. The child slot intentionally differs from the active
  // authority slot, so every mutation remains fenced until cutover commits and
  // the candidate is restarted with the new authority.
  return {
    REPO_HARNESS_WRITER_SLOT: slot,
    REPO_HARNESS_WRITER_EPOCH: authority.epoch,
    REPO_HARNESS_WRITER_FENCING_TOKEN: authority.fencingToken,
    ...(authority.generation ? { REPO_HARNESS_WRITER_GENERATION: authority.generation } : {}),
  };
}

export class SupervisorProcessManager {
  readonly options: SupervisorProcessManagerOptions;
  private readonly probe: ProcessIdentityProbe;

  constructor(options: SupervisorProcessManagerOptions) {
    this.options = { ...options, repoRoot: resolve(options.repoRoot), controllerHome: resolve(options.controllerHome) };
    this.probe = options.identityProbe ?? defaultProcessIdentityProbe;
  }

  private runtimeCli(): string {
    return this.options.runtimeExecutable ?? join(configuredRuntimeSourceRoot(this.options.runtimeSourceRoot), 'src', 'cli', 'index.ts');
  }

  private runtimeDaemon(): string {
    return this.options.daemonExecutable ?? join(configuredRuntimeSourceRoot(this.options.runtimeSourceRoot), 'src', 'runtime', 'control-plane', 'daemon-entry.ts');
  }

  gatewayBinding(slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot): { host: string; port: number } {
    const stablePort = this.options.stableIngressPort ?? 8765;
    const offset = this.options.gatewayPortOffset ?? 20;
    return {
      // Slot backends are never public listeners. Stable ingress is the only
      // binding that may follow the configured LAN/public host.
      host: '127.0.0.1',
      port: stablePort + offset + (slot === 'green' ? 10 : 0),
    };
  }

  private spawnDetached(component: SupervisorComponentName, home: string, args: string[], instanceId: string, slot: RuntimeSlotId): SpawnedSupervisorProcess {
    const command = process.execPath;
    mkdirSync(dirname(this.options.logPath), { recursive: true });
    const fd = openSync(this.options.logPath, 'a');
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: this.options.repoRoot,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: {
          ...process.env,
          REPO_HARNESS_CONTROLLER_HOME: home,
          REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER: '1',
          REPO_HARNESS_SUPERVISOR_CHILD: '1',
          REPO_HARNESS_SUPERVISOR_EPOCH: String(this.options.ownerEpoch),
          REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: this.options.runtimeSourceRoot,
          REPO_HARNESS_DAEMON_INSTANCE_ID: instanceId,
          REPO_HARNESS_RUNTIME_SLOT: slot,
          ...runtimeWriterEnvironment(this.options.controllerHome, slot),
        },
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    if (!child.pid) throw new Error(`SUPERVISOR_${component.toUpperCase()}_SPAWN_FAILED`);
    const commandText = processCommand(command, args);
    return {
      identity: {
        pid: child.pid,
        instanceId,
        processStartTime: new Date().toISOString(),
        executableFingerprint: executableFingerprint(commandText),
        controllerHome: home,
        slot,
        ...(this.options.releasePath ? { releasePath: resolve(this.options.releasePath) } : {}),
        ...(this.options.releaseRevision ? { releaseRevision: this.options.releaseRevision } : {}),
        ownerEpoch: this.options.ownerEpoch,
      },
      child,
      command,
      args,
      component,
      home,
    };
  }

  private async identify(spawned: SpawnedSupervisorProcess): Promise<SpawnedSupervisorProcess> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const identity = captureProcessIdentity(spawned.identity.pid, {
        controllerHome: spawned.identity.controllerHome,
        instanceId: spawned.identity.instanceId,
        ...(spawned.identity.slot ? { slot: spawned.identity.slot } : {}),
        ...(spawned.identity.releasePath ? { releasePath: spawned.identity.releasePath } : {}),
        ...(spawned.identity.releaseRevision ? { releaseRevision: spawned.identity.releaseRevision } : {}),
        ownerEpoch: spawned.identity.ownerEpoch,
      }, this.probe);
      if (identity) return { ...spawned, identity };
      if (!spawned.child?.pid || !this.probe.isAlive(spawned.child.pid)) {
        try { spawned.child?.kill('SIGTERM'); } catch { /* child may have already exited */ }
        throw new Error(`SUPERVISOR_${spawned.component.toUpperCase()}_PROCESS_DIED`);
      }
      await sleep(25);
    }
    // Identity probe fully exhausted but the child is still alive (e.g. ps
    // unavailable due to system restrictions). Accept the pre-populated
    // identity from spawnDetached so the Supervisor can proceed.
    return spawned;
  }

  async startDaemon(): Promise<SpawnedSupervisorProcess> {
    const slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot;
    const home = componentHome(this.options.controllerHome, slot, this.options.slot !== undefined);
    const instanceId = newProcessInstanceId('daemon');
    const args = [
      this.runtimeDaemon(),
      '--controller-home', home,
      '--runtime-source-root', this.options.runtimeSourceRoot,
      '--owner-epoch', String(this.options.ownerEpoch),
      '--instance-id', instanceId,
      '--slot', slot,
    ];
    return this.identify(this.spawnDetached('controllerDaemon', home, args, instanceId, slot));
  }

  gatewayArgs(home: string, slot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot): string[] {
    const localConfig = loadMcpServiceLocalConfig(home, this.options.repoRoot);
    const bridge = loadLocalBridgeConfig(this.options.repoRoot);
    const binding = this.gatewayBinding(slot);
    const host = binding.host;
    const port = binding.port;
    const profile = localConfig?.profile ?? 'controller';
    const auth = localConfig?.auth?.mode ?? 'oauth';
    const toolset = localConfig?.toolset ?? 'advanced';
    const localHost = localConfig?.localController?.host ?? bridge.host ?? '127.0.0.1';
    const localPort = localConfig?.localController?.port ?? bridge.port ?? 8766;
    const publicEndpoint = localConfig?.chatgpt?.endpoint;
    // The stable Supervisor owns the public ingress. Gateway hosts bind private
    // backend ports and must never create a competing tunnel lifecycle owner.
    const tunnelMode = 'none';
    const args = [
      this.runtimeCli(), 'mcp', 'keepalive',
      '--repo', this.options.repoRoot,
      '--controller-home', home,
      '--host', host,
      '--port', String(port),
      '--profile', profile,
      '--auth', auth,
      '--toolset', toolset,
      '--local-ui',
      '--local-ui-host', localHost,
      '--local-ui-port', String(localPort),
      '--tunnel', tunnelMode,
    ];
    if (publicEndpoint) args.push('--public-endpoint', publicEndpoint);
    if (localConfig?.devMode?.agentRunner) {
      args.push('--enable-dev-runner');
      if (localConfig.devMode.allowedAgents?.length) args.push('--dev-runner-agents', localConfig.devMode.allowedAgents.join(','));
      if (localConfig.devMode.timeoutMs) args.push('--dev-runner-timeout-ms', String(localConfig.devMode.timeoutMs));
      if (localConfig.devMode.maxTimeoutMs) args.push('--dev-runner-max-timeout-ms', String(localConfig.devMode.maxTimeoutMs));
    }
    return args;
  }

  async startGateway(): Promise<SpawnedSupervisorProcess> {
    const activeSlot = this.options.slot ?? readActiveSlotAuthority(this.options.controllerHome).activeSlot;
    const home = componentHome(this.options.controllerHome, activeSlot, this.options.slot !== undefined);
    const instanceId = newProcessInstanceId('gateway');
    return this.identify(this.spawnDetached('gatewayHost', home, this.gatewayArgs(home, activeSlot), instanceId, activeSlot));
  }

  observe(identity: ProcessIdentity | undefined): ProcessObservation {
    if (!identity || !this.probe.isAlive(identity.pid)) return 'dead';
    const command = this.probe.command(identity.pid);
    const startTime = this.probe.startTime(identity.pid);
    // When the OS probe is unavailable (e.g. restricted ps), accept the
    // isAlive check as sufficient evidence.  Return 'alive' so the Supervisor
    // can continue monitoring and recovery; the pre-populated spawn identity
    // carries the authoritative PID/start-time/fingerprint.
    if (!command || !startTime) return 'alive';
    return processIdentityMatches(identity, identity.pid, this.probe).matches ? 'alive' : 'unknown';
  }

  processCommandMatches(identity: ProcessIdentity | undefined, executablePaths: string[]): boolean {
    if (!identity || !this.probe.isAlive(identity.pid)) return false;
    const command = this.probe.command(identity.pid);
    // When the OS probe is unavailable, accept any alive process as matching.
    if (!command) return true;
    return executablePaths.some((path) => command.includes(resolve(path)));
  }

  async stop(identity: ProcessIdentity | undefined): Promise<{ stopped: boolean; observation: ProcessObservation }> {
    const observation = this.observe(identity);
    if (!identity || observation === 'dead') return { stopped: true, observation };
    // When the OS probe is unavailable, observe returns 'alive' after
    // verifying liveness.  Proceed with termination.
    if (observation === 'unknown') throw new Error(`SUPERVISOR_PROCESS_IDENTITY_MISMATCH: refusing to terminate pid=${identity.pid}`);
    const result = await terminateProcessTree(identity.pid, { gracePeriodMs: 1_500, killAfterMs: 8_000, pollIntervalMs: 100 });
    return { stopped: result.exited, observation: result.exited ? 'dead' : 'unknown' };
  }
}
