import { randomUUID } from 'crypto';
import { dirname, resolve } from 'path';
import { loadMcpServiceLocalConfig, loadMcpServiceRuntimeState, writeMcpServiceLocalConfig } from '../../cli/mcp/auth';
import {
  ensureSlotHome,
  isRollbackWindowOpen,
  markCutoverAuthority,
  markRollbackAuthority,
  oppositeSlot,
  readActiveSlotAuthority,
  readSlotIdentity,
  writeActiveSlotAuthority,
  writeSlotIdentity,
  type ActiveSlotAuthority,
  type RuntimeSlotId,
} from '../../cli/controller/runtime-slots';
import { CONTROLLER_SCOPE_REPO_ID } from '../../cli/repositories/controller-home';
import { readControllerDaemonStatus } from '../control-plane/daemon-client';
import { createExecutionJob, getExecutionJob } from '../execution/jobs/store';
import { readRuntimeGeneration } from '../control-plane/runtime-generation';
import { createSupervisorControlServer, type SupervisorControlServerHandle, type SupervisorControlHandlers } from './control-server';
import { createStableIngressRouter, type StableIngressRouterHandle } from './ingress-router';
import { createSupervisorOperation, listSupervisorOperations, readSupervisorOperation, updateSupervisorOperation } from './operation-store';
import { decideRestart, lockout, newRestartBudgetRecord, recordFailure, recordRestart, recordStable } from './restart-policy';
import { SupervisorProcessManager, type SpawnedSupervisorProcess, type SupervisorProcessManagerOptions } from './process-manager';
import { createSupervisorState, readSupervisorState, writeSupervisorState } from './state-store';
import { readCurrentSupervisorRelease, readPreviousSupervisorRelease, readSupervisorRelease, supervisorControlSocketPath, type SupervisorReleaseDescriptor } from './paths';
import type { RestartBudgetRecord, SupervisorComponentName, SupervisorManagedProcess, SupervisorOperation, SupervisorOperationKind, SupervisorState } from './types';

export interface StableSupervisorRuntimeOptions extends SupervisorProcessManagerOptions {
  controlHost?: string;
  controlPort?: number;
  rescueAuthToken?: string;
  releaseRevision?: string;
  onStopped?: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function processState(spawned: SpawnedSupervisorProcess, previous?: SupervisorManagedProcess): SupervisorManagedProcess {
  const now = new Date().toISOString();
  const generation = readRuntimeGeneration(spawned.identity.controllerHome)?.generation;
  return {
    ...spawned.identity,
    ...(generation ? { generation } : {}),
    state: 'running',
    lastLivenessAt: now,
    restartCount: previous?.restartCount ?? 0,
    consecutiveFailures: 0,
  };
}

function operationActive(operation: SupervisorOperation): boolean {
  return !['succeeded', 'failed', 'locked_out'].includes(operation.phase);
}

function operationKindForComponent(component: SupervisorComponentName): SupervisorOperationKind {
  return component === 'controllerDaemon' ? 'restart_controller' : 'restart_gateway';
}

function managedKey(component: SupervisorComponentName, generation?: string): string {
  return `${component}:${generation ?? 'unknown'}`;
}

export function terminalizeInterruptedSupervisorOperations(controllerHome: string): number {
  let terminalized = 0;
  for (const operation of listSupervisorOperations(controllerHome, 100)) {
    if (!operationActive(operation) || operation.phase === 'accepted' || operation.phase === 'scheduled') continue;
    updateSupervisorOperation(controllerHome, operation.operationId, {
      phase: 'failed',
      completedAt: new Date().toISOString(),
      failureClass: 'startup',
      error: 'SUPERVISOR_RESTART_INTERRUPTED_OPERATION',
      evidence: [...(operation.evidence ?? []), { kind: 'supervisor_restart', summary: 'Operation was terminalized instead of blindly replayed after Supervisor restart.', at: new Date().toISOString() }],
    });
    terminalized += 1;
  }
  return terminalized;
}

function currentManagedPairSlot(state: SupervisorState): RuntimeSlotId | undefined {
  if (!state.controllerDaemon || !state.gatewayHost) return undefined;
  const daemonSlot = state.controllerDaemon.slot ?? state.activeSlot;
  const gatewaySlot = state.gatewayHost.slot ?? state.activeSlot;
  return daemonSlot === gatewaySlot ? daemonSlot : undefined;
}

export function reconcileActiveManagedGenerations(
  state: SupervisorState,
  observed: { controllerDaemon?: string; gatewayHost?: string },
): { state: SupervisorState; coherent: boolean; generation?: string } {
  const daemon = state.controllerDaemon;
  const gateway = state.gatewayHost;
  const daemonSlot = daemon?.slot ?? state.activeSlot;
  const gatewaySlot = gateway?.slot ?? state.activeSlot;
  const activePair = Boolean(
    daemon
    && gateway
    && daemonSlot === state.activeSlot
    && gatewaySlot === state.activeSlot,
  );
  const coherentGeneration = activePair
    && observed.controllerDaemon
    && observed.gatewayHost
    && observed.controllerDaemon === observed.gatewayHost
    ? observed.controllerDaemon
    : undefined;
  const daemonChanged = Boolean(daemon && observed.controllerDaemon && daemon.generation !== observed.controllerDaemon);
  const gatewayChanged = Boolean(gateway && observed.gatewayHost && gateway.generation !== observed.gatewayHost);
  const activeChanged = Boolean(coherentGeneration && state.activeGeneration !== coherentGeneration);
  if (!daemonChanged && !gatewayChanged && !activeChanged) {
    return { state, coherent: Boolean(coherentGeneration), ...(coherentGeneration ? { generation: coherentGeneration } : {}) };
  }
  return {
    state: {
      ...state,
      ...(daemon && observed.controllerDaemon
        ? { controllerDaemon: { ...daemon, generation: observed.controllerDaemon } }
        : {}),
      ...(gateway && observed.gatewayHost
        ? { gatewayHost: { ...gateway, generation: observed.gatewayHost } }
        : {}),
      ...(coherentGeneration ? { activeGeneration: coherentGeneration } : {}),
      updatedAt: new Date().toISOString(),
    },
    coherent: Boolean(coherentGeneration),
    ...(coherentGeneration ? { generation: coherentGeneration } : {}),
  };
}

export function managedProcessNeedsReleaseRefresh(
  managed: SupervisorManagedProcess,
  expected: SupervisorReleaseDescriptor,
  ownerEpoch: number,
  processCommandMatches: boolean,
): boolean {
  return managed.ownerEpoch !== ownerEpoch
    || resolve(managed.releasePath ?? '') !== expected.releasePath
    || managed.releaseRevision !== expected.releaseRevision
    || !processCommandMatches;
}

export function reconcileSupervisorStateWithAuthority(
  state: SupervisorState,
  authority: ActiveSlotAuthority,
): SupervisorState {
  const now = new Date().toISOString();
  const currentSlot = currentManagedPairSlot(state);
  if (!state.controllerDaemon && !state.gatewayHost && !state.standby) {
    return {
      ...state,
      activeSlot: authority.activeSlot,
      previousSlot: authority.previousSlot,
      activeGeneration: authority.generation ?? state.activeGeneration,
      ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
      updatedAt: now,
    };
  }
  if (currentSlot === authority.activeSlot) {
    return {
      ...state,
      activeSlot: authority.activeSlot,
      previousSlot: authority.previousSlot,
      activeGeneration: authority.generation ?? state.controllerDaemon?.generation ?? state.activeGeneration,
      ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
      updatedAt: now,
    };
  }
  if (state.standby?.slot === authority.activeSlot) {
    const displaced = currentSlot && state.controllerDaemon && state.gatewayHost
      ? {
          slot: currentSlot,
          ...(state.controllerDaemon.generation ?? state.activeGeneration ? { generation: state.controllerDaemon.generation ?? state.activeGeneration } : {}),
          controllerDaemon: state.controllerDaemon,
          gatewayHost: state.gatewayHost,
          ...(authority.previousSlot === currentSlot && authority.rollbackUntil ? { retainedUntil: authority.rollbackUntil } : {}),
        }
      : undefined;
    return {
      ...state,
      activeSlot: authority.activeSlot,
      previousSlot: authority.previousSlot,
      activeGeneration: authority.generation ?? state.standby.generation ?? state.standby.controllerDaemon.generation,
      controllerDaemon: state.standby.controllerDaemon,
      gatewayHost: state.standby.gatewayHost,
      standby: displaced,
      observedState: 'degraded',
      ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
      lastIncident: { at: now, reason: 'Supervisor state was reconciled to the active-slot authority after restart.' },
      updatedAt: now,
    };
  }
  const displaced = currentSlot && currentSlot !== authority.activeSlot && state.controllerDaemon && state.gatewayHost
    ? {
        slot: currentSlot,
        ...(state.controllerDaemon.generation ?? state.activeGeneration ? { generation: state.controllerDaemon.generation ?? state.activeGeneration } : {}),
        controllerDaemon: state.controllerDaemon,
        gatewayHost: state.gatewayHost,
      }
    : state.standby?.slot !== authority.activeSlot ? state.standby : undefined;
  return {
    ...state,
    activeSlot: authority.activeSlot,
    previousSlot: authority.previousSlot,
    activeGeneration: authority.generation,
    controllerDaemon: undefined,
    gatewayHost: undefined,
    standby: displaced,
    observedState: 'degraded',
    ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
    lastIncident: { at: now, reason: 'No managed process pair matched the active-slot authority after restart; authority recovery is required.' },
    updatedAt: now,
  };
}

export function automaticRecoveryRequestId(
  component: SupervisorComponentName,
  generation: string | undefined,
  budget: RestartBudgetRecord,
): string {
  const parsedWindow = Date.parse(budget.windowStartedAt);
  const windowKey = Number.isFinite(parsedWindow) ? String(parsedWindow) : 'unknown';
  return `auto-recover:${component}:${generation ?? 'unknown'}:${windowKey}:${budget.attempts + 1}`;
}

export class StableSupervisorRuntime implements SupervisorControlHandlers {
  readonly options: StableSupervisorRuntimeOptions;
  readonly manager: SupervisorProcessManager;
  private state: SupervisorState;
  private control?: SupervisorControlServerHandle;
  private ingressRouter?: StableIngressRouterHandle;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private executionPromise?: Promise<void>;
  private stopping = false;

  constructor(options: StableSupervisorRuntimeOptions) {
    const serviceConfig = loadMcpServiceLocalConfig(options.controllerHome, options.repoRoot);
    const installedRelease = readSupervisorRelease(options.releasePath)
      ?? readCurrentSupervisorRelease(options.controllerHome);
    this.options = {
      ...options,
      ...(installedRelease ? {
        runtimeExecutable: options.runtimeExecutable ?? installedRelease.runtimeExecutable,
        daemonExecutable: options.daemonExecutable ?? installedRelease.daemonExecutable,
        runtimeSourceRoot: options.runtimeSourceRoot ?? installedRelease.sourceRoot ?? options.runtimeSourceRoot,
        releasePath: options.releasePath ?? installedRelease.releasePath,
        releaseRevision: options.releaseRevision ?? installedRelease.releaseRevision,
      } : {}),
      stableIngressHost: options.stableIngressHost ?? serviceConfig?.server?.host ?? '127.0.0.1',
      stableIngressPort: options.stableIngressPort ?? serviceConfig?.server?.port ?? 8765,
    };
    this.manager = new SupervisorProcessManager(this.options);
    const existing = readSupervisorState(options.controllerHome);
    this.state = existing ?? createSupervisorState(options.controllerHome, {
      pid: process.pid,
      instanceId: `sup-${process.pid}`,
      processStartTime: new Date().toISOString(),
      executableFingerprint: 'pending',
      controllerHome: options.controllerHome,
      ownerEpoch: options.ownerEpoch,
    }, { releaseRevision: options.releaseRevision });
  }

  getState(): SupervisorState | null {
    return this.state;
  }

  adoptSupervisorIdentity(identity: SupervisorState['supervisor'], releaseRevision?: string): void {
    const release = this.expectedManagedRelease();
    this.state = {
      ...this.state,
      supervisor: {
        ...identity,
        ...(release?.releasePath ? { releasePath: release.releasePath } : {}),
        ...(releaseRevision ?? release?.releaseRevision ? { releaseRevision: releaseRevision ?? release?.releaseRevision } : {}),
      },
      desiredState: 'running',
      observedState: 'starting',
      updatedAt: new Date().toISOString(),
    };
  }

  getOperation(operationId: string): SupervisorOperation | null {
    return readSupervisorOperation(this.options.controllerHome, operationId);
  }

  submitOperation(input: { requestId: string; kind: SupervisorOperationKind; actor: string; reason?: string }): { operation: SupervisorOperation; deduplicated: boolean } {
    return this.submitCommand(input);
  }

  submitCommand(input: { requestId: string; kind: SupervisorOperationKind; actor: string; reason?: string }): { operation: SupervisorOperation; deduplicated: boolean } {
    const accepted = createSupervisorOperation({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      requestId: input.requestId,
      kind: input.kind,
      requestedBy: input.actor,
      actor: input.actor,
      reason: input.reason,
    });
    void this.runPendingOperations();
    return accepted;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.reconcileInterruptedOperations();
    this.state = reconcileSupervisorStateWithAuthority(this.state, readActiveSlotAuthority(this.options.controllerHome));
    writeSupervisorState(this.options.controllerHome, this.state);
    this.control = await createSupervisorControlServer({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      controlHost: this.options.controlHost,
      controlPort: this.options.controlPort,
      authToken: this.options.rescueAuthToken,
      handlers: this,
      onStopped: this.options.onStopped,
    });
    this.ingressRouter = await createStableIngressRouter({
      host: this.options.stableIngressHost ?? '127.0.0.1',
      port: this.options.stableIngressPort ?? 8765,
      rescueHost: this.control.host,
      rescuePort: this.control.port,
      upstream: () => {
        const activeSlot = readActiveSlotAuthority(this.options.controllerHome).activeSlot;
        const gateway = this.gatewayForSlot(activeSlot);
        return gateway && this.manager.observe(gateway) === 'alive'
          ? this.manager.gatewayBinding(activeSlot)
          : null;
      },
    });
    this.state = this.persist({
      ingress: {
        ...this.state.ingress,
        state: 'running',
        activeUpstreamSlot: this.state.activeSlot,
        activeUpstreamPort: this.manager.gatewayBinding(this.state.activeSlot).port,
        lastHealthyAt: new Date().toISOString(),
      },
      control: {
        host: this.control.host,
        port: this.control.port,
        socketPath: supervisorControlSocketPath(this.options.controllerHome),
        rescueEndpoint: `http://${this.ingressRouter.host}:${this.ingressRouter.port}/rescue/mcp`,
      },
    });
    await this.ensureRuntime();
    this.state = this.persist({ observedState: 'healthy' });
    this.monitorTimer = setInterval(() => { void this.monitorTick(); }, 5_000);
    this.monitorTimer.unref?.();
    await this.runPendingOperations();
  }

  private reconcileInterruptedOperations(): void {
    terminalizeInterruptedSupervisorOperations(this.options.controllerHome);
    this.state = { ...this.state, currentOperationId: null };
  }

  private persist(patch: Partial<SupervisorState>): SupervisorState {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    writeSupervisorState(this.options.controllerHome, this.state);
    return this.state;
  }

  private observedGatewayGeneration(gateway = this.state.gatewayHost): string | undefined {
    if (!gateway) return undefined;
    const runtime = loadMcpServiceRuntimeState(gateway.controllerHome, this.options.repoRoot);
    const topLevelGeneration = runtime?.generation;
    const serverGeneration = runtime?.server.generation;
    if (topLevelGeneration && serverGeneration && topLevelGeneration !== serverGeneration) return undefined;
    return serverGeneration ?? topLevelGeneration;
  }

  private synchronizeActiveRuntimeGeneration(requireAgreement = false): string | undefined {
    const daemon = this.state.controllerDaemon;
    const gateway = this.state.gatewayHost;
    const daemonRuntime = daemon ? readRuntimeGeneration(daemon.controllerHome) : undefined;
    const gatewayGeneration = this.observedGatewayGeneration(gateway);
    const reconciled = reconcileActiveManagedGenerations(this.state, {
      ...(daemonRuntime?.generation ? { controllerDaemon: daemonRuntime.generation } : {}),
      ...(gatewayGeneration ? { gatewayHost: gatewayGeneration } : {}),
    });
    if (reconciled.state !== this.state) {
      this.state = reconciled.state;
      writeSupervisorState(this.options.controllerHome, this.state);
    }
    if (reconciled.generation) {
      const authority = readActiveSlotAuthority(this.options.controllerHome);
      if (authority.activeSlot === this.state.activeSlot && authority.generation !== reconciled.generation) {
        writeActiveSlotAuthority(this.options.controllerHome, {
          activeSlot: authority.activeSlot,
          ...(authority.previousSlot ? { previousSlot: authority.previousSlot } : {}),
          generation: reconciled.generation,
          reason: 'runtime-generation-sync',
          ...(authority.rollbackUntil ? { rollbackUntil: authority.rollbackUntil } : {}),
        });
      }
      const identity = readSlotIdentity(this.options.controllerHome, this.state.activeSlot);
      if (identity && (identity.generation !== reconciled.generation || identity.sourceCommit !== daemonRuntime?.source.commit)) {
        writeSlotIdentity(this.options.controllerHome, {
          ...identity,
          generation: reconciled.generation,
          ...(daemonRuntime?.source.commit ? { sourceCommit: daemonRuntime.source.commit } : {}),
        });
      }
    }
    if (requireAgreement && !reconciled.coherent) {
      throw new Error(
        `SUPERVISOR_ACTIVE_GENERATION_MISMATCH: daemon=${daemonRuntime?.generation ?? 'missing'} gateway=${gatewayGeneration ?? 'missing'}`,
      );
    }
    return reconciled.generation;
  }

  private componentState(component: SupervisorComponentName): SupervisorManagedProcess | undefined {
    return component === 'controllerDaemon' ? this.state.controllerDaemon : this.state.gatewayHost;
  }

  private gatewayForSlot(slot: RuntimeSlotId): SupervisorManagedProcess | undefined {
    if (this.state.gatewayHost && (this.state.gatewayHost.slot === slot || (!this.state.gatewayHost.slot && this.state.activeSlot === slot))) {
      return this.state.gatewayHost;
    }
    if (this.state.standby?.slot === slot) return this.state.standby.gatewayHost;
    return undefined;
  }

  private managerForSlot(slot: RuntimeSlotId, release?: SupervisorReleaseDescriptor): SupervisorProcessManager {
    return new SupervisorProcessManager({
      ...this.options,
      slot,
      ...(release ? {
        runtimeExecutable: release.runtimeExecutable,
        daemonExecutable: release.daemonExecutable,
        runtimeSourceRoot: release.sourceRoot ?? this.options.runtimeSourceRoot,
        releasePath: release.releasePath,
        releaseRevision: release.releaseRevision,
      } : {}),
    });
  }

  private managerForManaged(managed: SupervisorManagedProcess | undefined, fallbackSlot = this.state.activeSlot): SupervisorProcessManager {
    const release = readSupervisorRelease(managed?.releasePath);
    return this.managerForSlot(managed?.slot ?? fallbackSlot, release);
  }

  private expectedManagedRelease(): SupervisorReleaseDescriptor | undefined {
    return readSupervisorRelease(this.options.releasePath)
      ?? readCurrentSupervisorRelease(this.options.controllerHome);
  }

  private async reconcileManagedRelease(): Promise<void> {
    const expected = this.expectedManagedRelease();
    if (!expected) return;
    const daemon = this.state.controllerDaemon;
    const gateway = this.state.gatewayHost;
    const daemonNeedsRefresh = daemon
      ? managedProcessNeedsReleaseRefresh(
          daemon,
          expected,
          this.options.ownerEpoch,
          this.managerForManaged(daemon).processCommandMatches(daemon, [expected.daemonExecutable]),
        )
      : false;
    const gatewayNeedsRefresh = gateway
      ? managedProcessNeedsReleaseRefresh(
          gateway,
          expected,
          this.options.ownerEpoch,
          this.managerForManaged(gateway).processCommandMatches(gateway, [expected.runtimeExecutable]),
        )
      : false;
    if (!daemonNeedsRefresh && !gatewayNeedsRefresh) return;

    // Stop the dependent Gateway first. Each stop is identity-checked by the
    // persisted PID/start-time/fingerprint tuple; an unproven PID is never
    // terminated during release handoff.
    if (gateway) {
      const result = await this.managerForManaged(gateway).stop(gateway);
      if (!result.stopped) throw new Error('SUPERVISOR_GATEWAYHOST_RELEASE_HANDOFF_STOP_INCOMPLETE');
    }
    if (daemon) {
      const result = await this.managerForManaged(daemon).stop(daemon);
      if (!result.stopped) throw new Error('SUPERVISOR_CONTROLLERDAEMON_RELEASE_HANDOFF_STOP_INCOMPLETE');
    }
    this.persist({
      controllerDaemon: undefined,
      gatewayHost: undefined,
      activeGeneration: undefined,
      observedState: 'degraded',
      lastIncident: {
        at: new Date().toISOString(),
        reason: `Managed runtime release handoff to ${expected.releaseRevision ?? expected.releasePath}.`,
      },
    });
  }

  private prepareSlotConfig(slot: RuntimeSlotId, release?: SupervisorReleaseDescriptor): { home: string; localControllerPort: number; manager: SupervisorProcessManager } {
    const manager = this.managerForSlot(slot, release);
    const home = ensureSlotHome(this.options.controllerHome, slot);
    const activeHome = this.state.controllerDaemon?.controllerHome ?? this.options.controllerHome;
    const template = loadMcpServiceLocalConfig(activeHome, this.options.repoRoot)
      ?? loadMcpServiceLocalConfig(this.options.controllerHome, this.options.repoRoot);
    if (!template) throw new Error('SUPERVISOR_SLOT_CONFIG_UNAVAILABLE');
    const rootTemplate = loadMcpServiceLocalConfig(this.options.controllerHome, this.options.repoRoot) ?? template;
    const baseLocalPort = rootTemplate.localController?.port ?? 8766;
    const localControllerPort = baseLocalPort + (slot === 'green' ? 10 : 0);
    const binding = manager.gatewayBinding(slot);
    writeMcpServiceLocalConfig(home, {
      ...template,
      server: { ...template.server, host: binding.host, port: binding.port },
      localController: {
        enabled: true,
        host: template.localController?.host ?? '127.0.0.1',
        port: localControllerPort,
        autoOpen: false,
      },
    });
    return { home, localControllerPort, manager };
  }

  private async waitForManagedReady(
    manager: SupervisorProcessManager,
    component: SupervisorComponentName,
    managed: SupervisorManagedProcess,
    timeoutMs = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (manager.observe(managed) === 'alive') {
        if (component === 'controllerDaemon') {
          if (readControllerDaemonStatus(managed.controllerHome).status === 'ready') return;
        } else {
          const runtime = loadMcpServiceRuntimeState(managed.controllerHome, this.options.repoRoot);
          if (runtime?.server.healthy === true && runtime.status === 'running') return;
        }
      }
      await sleep(250);
    }
    throw new Error(`SUPERVISOR_${component.toUpperCase()}_READINESS_TIMEOUT`);
  }

  private async startSlot(slot: RuntimeSlotId, release?: SupervisorReleaseDescriptor): Promise<{
    slot: RuntimeSlotId;
    generation?: string;
    manager: SupervisorProcessManager;
    controllerDaemon: SupervisorManagedProcess;
    gatewayHost: SupervisorManagedProcess;
    localControllerPort: number;
    durableJobId: string;
  }> {
    const prepared = this.prepareSlotConfig(slot, release);
    let daemon: SupervisorManagedProcess | undefined;
    let gateway: SupervisorManagedProcess | undefined;
    try {
      const daemonSpawned = await prepared.manager.startDaemon();
      daemon = processState(daemonSpawned);
      await this.waitForManagedReady(prepared.manager, 'controllerDaemon', daemon);
      const gatewaySpawned = await prepared.manager.startGateway();
      gateway = processState(gatewaySpawned);
      await this.waitForManagedReady(prepared.manager, 'gatewayHost', gateway);
      const generation = readRuntimeGeneration(daemon.controllerHome)?.generation ?? daemon.generation;
      const sourceCommit = readRuntimeGeneration(daemon.controllerHome)?.source.commit;
      const gatewayRuntime = loadMcpServiceRuntimeState(gateway.controllerHome, this.options.repoRoot);
      if (!generation || gatewayRuntime?.generation !== generation || gatewayRuntime.server.generation !== generation) {
        throw new Error('SUPERVISOR_CANDIDATE_GENERATION_MISMATCH');
      }
      if (gatewayRuntime.server.profile !== 'controller') throw new Error('SUPERVISOR_CANDIDATE_PROFILE_MISMATCH');
      const toolFingerprint = gatewayRuntime.server.toolSurfaceFingerprint ?? gatewayRuntime.server.runtimeToolSurfaceFingerprint;
      if (!toolFingerprint) throw new Error('SUPERVISOR_CANDIDATE_TOOL_FINGERPRINT_MISSING');
      const requestId = `supervisor-slot-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const created = createExecutionJob(daemon.controllerHome, {
        repoId: CONTROLLER_SCOPE_REPO_ID,
        type: 'mcp-tool',
        requestId,
        semanticKey: `supervisor-slot-smoke:${requestId}`,
        payload: { operation: 'controller_ready', arguments: { repo: this.options.repoRoot }, target: 'runtime' },
        origin: { surface: 'system', actor: 'stable-supervisor-slot-verify' },
        timeoutMs: 30_000,
        maxAttempts: 1,
      });
      const durableJobId = created.job.jobId;
      const durableDeadline = Date.now() + 30_000;
      let durableStatus = getExecutionJob(daemon.controllerHome, CONTROLLER_SCOPE_REPO_ID, durableJobId)?.status;
      while (Date.now() < durableDeadline && durableStatus && !['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(durableStatus)) {
        await sleep(100);
        durableStatus = getExecutionJob(daemon.controllerHome, CONTROLLER_SCOPE_REPO_ID, durableJobId)?.status;
      }
      if (!durableStatus) throw new Error('SUPERVISOR_CANDIDATE_DURABLE_JOB_UNREADABLE');
      if (durableStatus !== 'succeeded') throw new Error(`SUPERVISOR_CANDIDATE_DURABLE_JOB_${durableStatus.toUpperCase()}`);
      writeSlotIdentity(this.options.controllerHome, {
        schemaVersion: 1,
        slot,
        role: 'candidate',
        controllerHome: this.options.controllerHome,
        slotHome: daemon.controllerHome,
        mcpPort: prepared.manager.gatewayBinding(slot).port,
        localControllerPort: prepared.localControllerPort,
        ...(generation ? { generation } : {}),
        ...(sourceCommit ? { sourceCommit } : {}),
        ...(daemon.releasePath ? { releasePath: daemon.releasePath } : {}),
        ...(daemon.releaseRevision ? { releaseRevision: daemon.releaseRevision } : {}),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        logDir: dirname(this.options.logPath),
      });
      return { slot, generation, manager: prepared.manager, controllerDaemon: daemon, gatewayHost: gateway, localControllerPort: prepared.localControllerPort, durableJobId }; 
    } catch (error) {
      if (gateway) await prepared.manager.stop(gateway).catch(() => undefined);
      if (daemon) await prepared.manager.stop(daemon).catch(() => undefined);
      throw error;
    }
  }

  private async verifyStableIngress(expectedGeneration?: string): Promise<void> {
    const configuredHost = this.options.stableIngressHost ?? '127.0.0.1';
    const host = configuredHost === '0.0.0.0' || configuredHost === '::' ? '127.0.0.1' : configuredHost;
    const port = this.options.stableIngressPort ?? 8765;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`status=${response.status}`);
      const payload = await response.json() as { status?: string; generation?: string };
      if (payload.status !== 'ok') throw new Error(`health=${String(payload.status)}`);
      if (expectedGeneration && payload.generation !== expectedGeneration) {
        throw new Error(`generation=${String(payload.generation)} expected=${expectedGeneration}`);
      }
    } catch (error) {
      throw new Error(`SUPERVISOR_STABLE_INGRESS_VERIFY_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async stopSlotProcesses(input: { slot: RuntimeSlotId; controllerDaemon: SupervisorManagedProcess; gatewayHost: SupervisorManagedProcess }): Promise<void> {
    await this.managerForManaged(input.gatewayHost, input.slot).stop(input.gatewayHost).catch(() => undefined);
    await this.managerForManaged(input.controllerDaemon, input.slot).stop(input.controllerDaemon).catch(() => undefined);
  }

  private async rollout(operationId: string): Promise<void> {
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const previousSlot = authority.activeSlot;
    const candidateSlot = oppositeSlot(previousSlot);
    const previousDaemon = this.state.controllerDaemon;
    const previousGateway = this.state.gatewayHost;
    if (!previousDaemon || !previousGateway) throw new Error('SUPERVISOR_ACTIVE_RUNTIME_MISSING');
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
    const candidateRelease = readCurrentSupervisorRelease(this.options.controllerHome);
    const candidate = await this.startSlot(candidateSlot, candidateRelease);
    updateSupervisorOperation(this.options.controllerHome, operationId, {
      phase: 'verifying',
      evidence: [{ kind: 'candidate_verification', summary: `Candidate ${candidateSlot} passed generation, tool-surface, daemon/Gateway readiness, and durable-store verification (${candidate.durableJobId}).`, at: new Date().toISOString() }],
    });
    const previousGeneration = previousDaemon.generation ?? this.state.activeGeneration;
    this.persist({
      activeSlot: candidateSlot,
      activeGeneration: candidate.generation,
      controllerDaemon: candidate.controllerDaemon,
      gatewayHost: candidate.gatewayHost,
      standby: {
        slot: previousSlot,
        ...(previousGeneration ? { generation: previousGeneration } : {}),
        controllerDaemon: previousDaemon,
        gatewayHost: previousGateway,
      },
    });
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'switching_ingress' });
    const nextAuthority = markCutoverAuthority(this.options.controllerHome, candidateSlot, candidate.generation);
    this.persist({
      previousSlot,
      standby: this.state.standby ? { ...this.state.standby, retainedUntil: nextAuthority.rollbackUntil } : undefined,
      ingress: {
        ...this.state.ingress,
        activeUpstreamSlot: candidateSlot,
        activeUpstreamPort: candidate.manager.gatewayBinding(candidateSlot).port,
      },
    });
    try {
      await this.verifyStableIngress(candidate.generation);
      writeSlotIdentity(this.options.controllerHome, {
        ...(readSlotIdentity(this.options.controllerHome, candidateSlot) ?? {
          schemaVersion: 1,
          slot: candidateSlot,
          controllerHome: this.options.controllerHome,
          slotHome: candidate.controllerDaemon.controllerHome,
          mcpPort: candidate.manager.gatewayBinding(candidateSlot).port,
          localControllerPort: candidate.localControllerPort,
          updatedAt: new Date().toISOString(),
          logDir: dirname(this.options.logPath),
        }),
        role: 'active',
      });
      const previousIdentity = readSlotIdentity(this.options.controllerHome, previousSlot);
      if (previousIdentity) writeSlotIdentity(this.options.controllerHome, { ...previousIdentity, role: 'standby' });
      updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'cutover' });
    } catch (error) {
      markRollbackAuthority(this.options.controllerHome, previousGeneration);
      this.persist({
        activeSlot: previousSlot,
        previousSlot: candidateSlot,
        activeGeneration: previousGeneration,
        controllerDaemon: previousDaemon,
        gatewayHost: previousGateway,
        standby: undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: previousSlot,
          activeUpstreamPort: this.managerForSlot(previousSlot).gatewayBinding(previousSlot).port,
        },
      });
      await this.stopSlotProcesses(candidate);
      const identity = readSlotIdentity(this.options.controllerHome, candidateSlot);
      if (identity) writeSlotIdentity(this.options.controllerHome, { ...identity, role: 'failed' });
      throw error;
    }
  }

  private async rollback(operationId: string): Promise<void> {
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const currentSlot = authority.activeSlot;
    const targetSlot = authority.previousSlot ?? this.state.standby?.slot;
    if (!targetSlot) throw new Error('SUPERVISOR_ROLLBACK_TARGET_MISSING');
    const failedDaemon = this.state.controllerDaemon;
    const failedGateway = this.state.gatewayHost;
    if (!failedDaemon || !failedGateway) throw new Error('SUPERVISOR_ACTIVE_RUNTIME_MISSING');
    let targetWasExistingStandby = false;
    let target: {
      slot: RuntimeSlotId;
      generation?: string;
      manager: SupervisorProcessManager;
      controllerDaemon: SupervisorManagedProcess;
      gatewayHost: SupervisorManagedProcess;
      localControllerPort: number;
      durableJobId: string;
    };
    if (
      this.state.standby?.slot === targetSlot
      && this.manager.observe(this.state.standby.controllerDaemon) === 'alive'
      && this.manager.observe(this.state.standby.gatewayHost) === 'alive'
    ) {
      targetWasExistingStandby = true;
      const manager = this.managerForManaged(this.state.standby.controllerDaemon, targetSlot);
      target = {
        slot: targetSlot,
        generation: this.state.standby.generation,
        manager,
        controllerDaemon: this.state.standby.controllerDaemon,
        gatewayHost: this.state.standby.gatewayHost,
        localControllerPort: loadMcpServiceLocalConfig(this.state.standby.controllerDaemon.controllerHome, this.options.repoRoot)?.localController?.port ?? 8766,
        durableJobId: 'existing-standby',
      };
    } else {
      updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
      const targetIdentity = readSlotIdentity(this.options.controllerHome, targetSlot);
      const targetRelease = readSupervisorRelease(targetIdentity?.releasePath) ?? readPreviousSupervisorRelease(this.options.controllerHome);
      target = await this.startSlot(targetSlot, targetRelease);
    }
    this.persist({
      activeSlot: targetSlot,
      activeGeneration: target.generation,
      controllerDaemon: target.controllerDaemon,
      gatewayHost: target.gatewayHost,
      standby: {
        slot: currentSlot,
        ...(failedDaemon.generation ? { generation: failedDaemon.generation } : {}),
        controllerDaemon: failedDaemon,
        gatewayHost: failedGateway,
      },
    });
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'rolling_back' });
    markRollbackAuthority(this.options.controllerHome, target.generation);
    this.persist({
      previousSlot: currentSlot,
      ingress: {
        ...this.state.ingress,
        activeUpstreamSlot: targetSlot,
        activeUpstreamPort: target.manager.gatewayBinding(targetSlot).port,
      },
    });
    try {
      await this.verifyStableIngress(target.generation);
    } catch (error) {
      markRollbackAuthority(this.options.controllerHome, failedDaemon.generation ?? this.state.activeGeneration);
      this.persist({
        activeSlot: currentSlot,
        activeGeneration: failedDaemon.generation,
        controllerDaemon: failedDaemon,
        gatewayHost: failedGateway,
        standby: targetWasExistingStandby ? {
          slot: targetSlot,
          ...(target.generation ? { generation: target.generation } : {}),
          controllerDaemon: target.controllerDaemon,
          gatewayHost: target.gatewayHost,
          retainedUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
        } : undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: currentSlot,
          activeUpstreamPort: this.managerForSlot(currentSlot).gatewayBinding(currentSlot).port,
        },
      });
      if (!targetWasExistingStandby) await this.stopSlotProcesses(target);
      throw error;
    }
    await this.stopSlotProcesses({ slot: currentSlot, controllerDaemon: failedDaemon, gatewayHost: failedGateway });
    this.persist({ standby: undefined });
    const targetIdentity = readSlotIdentity(this.options.controllerHome, targetSlot);
    if (targetIdentity) writeSlotIdentity(this.options.controllerHome, { ...targetIdentity, role: 'active' });
    const failedIdentity = readSlotIdentity(this.options.controllerHome, currentSlot);
    if (failedIdentity) writeSlotIdentity(this.options.controllerHome, { ...failedIdentity, role: 'failed' });
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'cutover' });
  }

  private async cleanupExpiredStandby(): Promise<void> {
    const standby = this.state.standby;
    if (!standby || this.state.currentOperationId) return;
    const retainedUntil = standby.retainedUntil ? Date.parse(standby.retainedUntil) : Number.NaN;
    if (Number.isFinite(retainedUntil) && retainedUntil > Date.now()) return;
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    if (!standby.retainedUntil && isRollbackWindowOpen(authority)) return;
    await this.stopSlotProcesses(standby);
    const identity = readSlotIdentity(this.options.controllerHome, standby.slot);
    if (identity) writeSlotIdentity(this.options.controllerHome, { ...identity, role: 'inactive' });
    this.persist({ standby: undefined });
  }

  private setComponent(component: SupervisorComponentName, value: SupervisorManagedProcess | undefined): void {
    if (component === 'controllerDaemon') this.persist({ controllerDaemon: value });
    else this.persist({ gatewayHost: value });
  }

  private async ensureRuntime(): Promise<void> {
    if (this.stopping || this.state.desiredState !== 'running') return;
    await this.reconcileManagedRelease();
    const expectedRelease = this.expectedManagedRelease();
    const activeSlot = this.state.controllerDaemon?.slot
      ?? this.state.gatewayHost?.slot
      ?? this.state.activeSlot;
    const currentReleaseManager = expectedRelease
      ? this.managerForSlot(activeSlot, expectedRelease)
      : undefined;
    if (!this.state.controllerDaemon || this.manager.observe(this.state.controllerDaemon) !== 'alive') {
      const previous = this.state.controllerDaemon;
      const started = await (currentReleaseManager ?? this.managerForManaged(previous, activeSlot)).startDaemon();
      this.setComponent('controllerDaemon', processState(started, previous));
    }
    await this.waitForReady('controllerDaemon');
    const daemonGeneration = this.state.controllerDaemon
      ? readRuntimeGeneration(this.state.controllerDaemon.controllerHome)?.generation
      : undefined;
    const currentGateway = this.state.gatewayHost;
    if (
      currentGateway
      && this.manager.observe(currentGateway) === 'alive'
      && daemonGeneration
      && this.observedGatewayGeneration(currentGateway) !== daemonGeneration
    ) {
      const stopped = await this.managerForManaged(currentGateway).stop(currentGateway);
      if (!stopped.stopped) throw new Error('SUPERVISOR_GATEWAYHOST_GENERATION_REFRESH_STOP_INCOMPLETE');
      this.setComponent('gatewayHost', { ...currentGateway, state: 'stopped', lastLivenessAt: new Date().toISOString() });
    }
    if (!this.state.gatewayHost || this.manager.observe(this.state.gatewayHost) !== 'alive') {
      const previous = this.state.gatewayHost;
      const started = await (currentReleaseManager ?? this.managerForManaged(previous, activeSlot)).startGateway();
      this.setComponent('gatewayHost', processState(started, previous));
    }
    await this.waitForReady('gatewayHost');
    const activeGeneration = this.synchronizeActiveRuntimeGeneration(true);
    this.persist({
      activeSlot: this.state.controllerDaemon?.slot ?? this.state.activeSlot,
      ...(activeGeneration ? { activeGeneration } : {}),
      ingress: {
        ...this.state.ingress,
        activeUpstreamSlot: this.state.gatewayHost?.slot ?? this.state.activeSlot,
        activeUpstreamPort: this.manager.gatewayBinding(this.state.gatewayHost?.slot ?? this.state.activeSlot).port,
      },
    });
  }

  private async waitForReady(component: SupervisorComponentName): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const managed = this.componentState(component);
      if (managed && this.managerForManaged(managed).observe(managed) === 'alive') {
        if (component === 'controllerDaemon') {
          const daemon = readControllerDaemonStatus(managed.controllerHome);
          if (daemon.status === 'ready') return;
        } else {
          const runtime = loadMcpServiceRuntimeState(managed.controllerHome, this.options.repoRoot);
          if (runtime?.server.healthy === true || runtime?.status === 'running') return;
        }
      }
      await sleep(250);
    }
    throw new Error(`SUPERVISOR_${component.toUpperCase()}_READINESS_TIMEOUT`);
  }

  private async stopComponent(component: SupervisorComponentName): Promise<void> {
    const current = this.componentState(component);
    if (!current) return;
    const result = await this.managerForManaged(current).stop(current);
    if (!result.stopped) throw new Error(`SUPERVISOR_${component.toUpperCase()}_STOP_INCOMPLETE`);
    this.setComponent(component, { ...current, state: 'stopped', lastLivenessAt: new Date().toISOString() });
  }

  private async restartComponent(component: SupervisorComponentName, operationId: string): Promise<void> {
    const current = this.componentState(component);
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'stopping', startedAt: new Date().toISOString() });
    if (current) await this.stopComponent(component);
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
    const manager = this.managerForManaged(current);
    const started = component === 'controllerDaemon' ? await manager.startDaemon() : await manager.startGateway();
    this.setComponent(component, processState(started, current));
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'verifying' });
    await this.waitForReady(component);
  }

  private async executeOperation(operation: SupervisorOperation): Promise<void> {
    let current = updateSupervisorOperation(this.options.controllerHome, operation.operationId, { phase: 'scheduled', scheduledAt: new Date().toISOString() });
    this.persist({ currentOperationId: operation.operationId, observedState: 'degraded' });
    try {
      if (current.kind === 'restart_controller') {
        await this.restartComponent('controllerDaemon', current.operationId);
        // Daemon startup rotates the slot generation. Refresh the dependent
        // Gateway so Connector and daemon generation identities cannot diverge.
        await this.restartComponent('gatewayHost', current.operationId);
      } else if (current.kind === 'restart_gateway') {
        await this.restartComponent('gatewayHost', current.operationId);
      } else if (current.kind === 'restart_full') {
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'stopping', startedAt: new Date().toISOString() });
        await this.stopComponent('gatewayHost');
        await this.stopComponent('controllerDaemon');
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'starting' });
        await this.ensureRuntime();
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'verifying' });
        await this.waitForReady('controllerDaemon');
        await this.waitForReady('gatewayHost');
      } else if (current.kind === 'unlock_and_recover') {
        const restartBudget = Object.fromEntries(Object.entries(this.state.restartBudget).map(([key, value]) => [key, { ...value, lockedOut: false, reason: undefined }]));
        this.persist({ restartBudget, observedState: 'degraded' });
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'starting' });
        await this.ensureRuntime();
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'verifying' });
        await this.waitForReady('controllerDaemon');
        await this.waitForReady('gatewayHost');
      } else if (current.kind === 'rollout') {
        await this.rollout(current.operationId);
      } else {
        await this.rollback(current.operationId);
      }
      this.synchronizeActiveRuntimeGeneration(true);
      current = updateSupervisorOperation(this.options.controllerHome, current.operationId, {
        phase: 'succeeded',
        completedAt: new Date().toISOString(),
        result: {
          operationId: current.operationId,
          runtimeGeneration: this.state.activeGeneration,
          reconnectContract: 'stable_domain_retry',
        },
      });
      this.persist({ currentOperationId: null, observedState: 'healthy' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current = updateSupervisorOperation(this.options.controllerHome, current.operationId, {
        phase: 'failed',
        completedAt: new Date().toISOString(),
        failureClass: message.includes('READINESS') ? 'readiness' : message.includes('IDENTITY') ? 'identity' : 'unknown',
        error: message,
      });
      this.persist({ currentOperationId: null, observedState: 'degraded', lastIncident: { at: new Date().toISOString(), reason: message, operationId: current.operationId } });
    }
  }

  private async runPendingOperations(): Promise<void> {
    if (this.executionPromise || this.stopping) return;
    this.executionPromise = (async () => {
      const pending = listSupervisorOperations(this.options.controllerHome, 100)
        .filter((operation) => operation.phase === 'accepted' || operation.phase === 'scheduled')
        .sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
      const next = pending[0];
      if (next) await this.executeOperation(next);
    })().finally(() => {
      this.executionPromise = undefined;
    });
    await this.executionPromise;
  }

  private async recoverComponent(component: SupervisorComponentName): Promise<void> {
    const managed = this.componentState(component);
    if (!managed) return;
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const standby = this.state.standby;
    if (
      !this.state.currentOperationId
      && standby
      && standby.slot === authority.previousSlot
      && isRollbackWindowOpen(authority)
      && this.manager.observe(standby.controllerDaemon) === 'alive'
      && this.manager.observe(standby.gatewayHost) === 'alive'
    ) {
      const accepted = createSupervisorOperation({
        controllerHome: this.options.controllerHome,
        repoRoot: this.options.repoRoot,
        requestId: `auto-rollback:${authority.activeSlot}:${authority.generation ?? 'unknown'}`,
        kind: 'rollback',
        requestedBy: 'supervisor',
        actor: 'supervisor',
        reason: `${component} failed within the rollback window`,
      });
      this.persist({
        lastIncident: { at: new Date().toISOString(), component, reason: `${component} failed; automatic rollback accepted`, operationId: accepted.operation.operationId },
      });
      await this.runPendingOperations();
      return;
    }
    const generation = managed.generation ?? this.state.activeGeneration;
    const key = managedKey(component, generation);
    const budget = this.state.restartBudget[key] ?? newRestartBudgetRecord(component, generation);
    const decision = decideRestart(budget);
    if (!decision.allowed) {
      if (decision.reason === 'backoff') {
        this.persist({
          observedState: 'degraded',
          lastIncident: { at: new Date().toISOString(), component, reason: `restart backoff active for ${decision.delayMs}ms` },
        });
        return;
      }
      this.persist({
        observedState: 'locked_out',
        restartBudget: { ...this.state.restartBudget, [key]: lockout(budget, decision.reason ?? 'restart budget exhausted') },
        lastIncident: { at: new Date().toISOString(), component, reason: decision.reason ?? 'restart budget exhausted' },
      });
      return;
    }
    const requestId = automaticRecoveryRequestId(component, generation, budget);
    const accepted = createSupervisorOperation({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      requestId,
      kind: operationKindForComponent(component),
      requestedBy: 'supervisor',
      actor: 'supervisor',
      reason: `${component} liveness failed`,
    });
    this.persist({
      restartBudget: { ...this.state.restartBudget, [key]: recordRestart(recordFailure(budget, `${component} liveness failed`)) },
      lastIncident: { at: new Date().toISOString(), component, reason: `${component} liveness failed`, operationId: accepted.operation.operationId },
    });
    await this.runPendingOperations();
  }

  private async monitorTick(): Promise<void> {
    if (this.stopping || this.state.desiredState !== 'running') return;
    let degraded = !this.synchronizeActiveRuntimeGeneration(false);
    for (const component of ['controllerDaemon', 'gatewayHost'] as const) {
      const managed = this.componentState(component);
      const observation = this.manager.observe(managed);
      if (observation === 'alive' && managed) {
        const key = managedKey(component, managed.generation ?? this.state.activeGeneration);
        const budget = this.state.restartBudget[key];
        this.persist({
          ...(budget ? { restartBudget: { ...this.state.restartBudget, [key]: recordStable(budget) } } : {}),
          ...(component === 'controllerDaemon' ? { controllerDaemon: { ...managed, lastLivenessAt: new Date().toISOString() } } : { gatewayHost: { ...managed, lastLivenessAt: new Date().toISOString() } }),
        });
      } else if (observation === 'dead') {
        degraded = true;
        await this.recoverComponent(component);
      } else {
        degraded = true;
        this.persist({ lastIncident: { at: new Date().toISOString(), component, reason: 'process identity could not be proven; process retained' } });
      }
    }
    if (this.state.observedState !== 'locked_out') {
      this.persist({
        observedState: degraded || Boolean(this.state.currentOperationId) ? 'degraded' : 'healthy',
        ingress: {
          ...this.state.ingress,
          state: this.manager.observe(this.state.gatewayHost) === 'alive' ? 'running' : 'degraded',
          ...(this.manager.observe(this.state.gatewayHost) === 'alive' ? { lastHealthyAt: new Date().toISOString() } : {}),
        },
      });
    }
    await this.runPendingOperations();
    await this.cleanupExpiredStandby();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.persist({ desiredState: 'stopped', observedState: 'stopped' });
    await this.stopComponent('gatewayHost');
    await this.stopComponent('controllerDaemon');
    if (this.state.standby) await this.stopSlotProcesses(this.state.standby);
    this.persist({ standby: undefined });
    if (this.ingressRouter) await this.ingressRouter.close();
    this.ingressRouter = undefined;
    if (this.control) await this.control.close();
    this.control = undefined;
    this.persist({ currentOperationId: null, ingress: { ...this.state.ingress, state: 'stopped' } });
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
