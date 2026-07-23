import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import { dirname, resolve, sep } from 'path';
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
import { createStableIngressProcess, type StableIngressProcessHandle } from './ingress-process';
import { createSupervisorOperation, listSupervisorOperations, readSupervisorOperation, updateSupervisorOperation } from './operation-store';
import { DEFAULT_RESTART_POLICY, decideRestart, lockout, newRestartBudgetRecord, recordFailure, recordRestart, recordStable } from './restart-policy';
import { SupervisorProcessManager, type SpawnedSupervisorProcess, type SupervisorProcessManagerOptions } from './process-manager';
import { createSupervisorState, readSupervisorState, writeSupervisorState } from './state-store';
import { readCurrentSupervisorRelease, readPreviousSupervisorRelease, readSupervisorRelease, supervisorControlSocketPath, supervisorReleasesRoot, type SupervisorReleaseDescriptor } from './paths';
import { publishSupervisorRelease } from './installer';
import {
  publishAndScheduleSupervisorRelease,
  scheduleServiceActivation,
  type SupervisorReleaseActivationResult,
} from './service-activation';
import type { RestartBudgetRecord, SupervisorComponentName, SupervisorManagedProcess, SupervisorOperation, SupervisorOperationKind, SupervisorState } from './types';

export interface StableSupervisorRuntimeOptions extends SupervisorProcessManagerOptions {
  controlHost?: string;
  controlPort?: number;
  rescueAuthToken?: string;
  releaseRevision?: string;
  ingressExecutable?: string;
  serviceActivationScheduler?: typeof scheduleServiceActivation;
  activatePublishedRelease?: boolean;
  onStopped?: () => void;
}

interface StartedRuntimeSlot {
  slot: RuntimeSlotId;
  generation?: string;
  manager: SupervisorProcessManager;
  controllerDaemon: SupervisorManagedProcess;
  gatewayHost: SupervisorManagedProcess;
  localControllerPort: number;
  durableJobId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export const SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD = Math.max(
  1,
  Math.ceil(DEFAULT_RESTART_POLICY.unhealthyWindowMs / DEFAULT_RESTART_POLICY.probeIntervalMs),
);

export interface SupervisorGatewayHealthProbeResult {
  healthy: boolean;
  detail: string;
  statusCode?: number;
  ready?: boolean;
  recoveryRecommended?: boolean;
}

export function supervisorGatewayHealthDecision(
  previousFailures: number,
  healthy: boolean,
): { consecutiveFailures: number; shouldRecover: boolean } {
  const consecutiveFailures = healthy ? 0 : Math.max(0, previousFailures) + 1;
  return {
    consecutiveFailures,
    shouldRecover: !healthy && consecutiveFailures >= SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD,
  };
}

export const SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD = SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD;

export function supervisorIngressHealthDecision(
  previousFailures: number,
  healthy: boolean,
  recoverySuppressed = false,
): { consecutiveFailures: number; shouldReplace: boolean } {
  const consecutiveFailures = healthy ? 0 : Math.max(0, previousFailures) + 1;
  return {
    consecutiveFailures,
    shouldReplace: !recoverySuppressed
      && !healthy
      && consecutiveFailures >= SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD,
  };
}

export async function probeSupervisorGatewayHealth(
  endpoint: string,
  timeoutMs = 2_000,
): Promise<SupervisorGatewayHealthProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    let healthStatus: unknown;
    let readiness: unknown;
    let recoveryRecommended = false;
    try {
      const payload = await response.json() as {
        status?: unknown;
        ready?: unknown;
        sessionCapacity?: { recoveryRecommended?: unknown; acceptingNewSessions?: unknown };
      };
      healthStatus = payload?.status;
      readiness = payload?.ready;
      recoveryRecommended = payload?.sessionCapacity?.recoveryRecommended === true;
    } catch {
      healthStatus = undefined;
      readiness = undefined;
    }
    if (readiness === false) {
      return {
        healthy: true,
        ready: false,
        recoveryRecommended,
        statusCode: response.status,
        detail: recoveryRecommended
          ? 'gateway readiness requires bounded recovery'
          : 'gateway is live but temporarily not ready',
      };
    }
    if (!response.ok) {
      return {
        healthy: false,
        statusCode: response.status,
        detail: `status=${response.status}${healthStatus === undefined ? '' : ` health=${String(healthStatus)}`}`,
      };
    }
    if (readiness === true) {
      return { healthy: true, ready: true, recoveryRecommended: false, statusCode: response.status, detail: 'ready' };
    }
    if (healthStatus !== 'ok') {
      return { healthy: false, statusCode: response.status, detail: `health=${String(healthStatus)}` };
    }
    return { healthy: true, statusCode: response.status, detail: 'ok' };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
    return { healthy: false, detail: detail || 'health probe failed' };
  } finally {
    clearTimeout(timeout);
  }
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
  private ingressProcess?: StableIngressProcessHandle;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private monitorPromise?: Promise<void>;
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

  submitOperation(input: { requestId: string; kind: SupervisorOperationKind; actor: string; reason?: string; candidateReleasePath?: string }): { operation: SupervisorOperation; deduplicated: boolean } {
    return this.submitCommand(input);
  }

  submitCommand(input: { requestId: string; kind: SupervisorOperationKind; actor: string; reason?: string; candidateReleasePath?: string }): { operation: SupervisorOperation; deduplicated: boolean } {
    const accepted = createSupervisorOperation({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      requestId: input.requestId,
      kind: input.kind,
      requestedBy: input.actor,
      actor: input.actor,
      reason: input.reason,
      candidateReleasePath: input.candidateReleasePath,
    });
    void this.runPendingOperations();
    return accepted;
  }

  private async replaceIngressProcess(): Promise<StableIngressProcessHandle> {
    await this.ingressProcess?.close();
    const ingressExecutable = this.options.ingressExecutable ?? process.argv[1];
    if (!ingressExecutable || !this.control) throw new Error('SUPERVISOR_INGRESS_RESTART_CONTEXT_MISSING');
    this.ingressProcess = await createStableIngressProcess({
      executable: ingressExecutable,
      repoRoot: this.options.repoRoot,
      controllerHome: this.options.controllerHome,
      host: this.options.stableIngressHost ?? '127.0.0.1',
      port: this.options.stableIngressPort ?? 8765,
      rescueHost: this.control.host,
      rescuePort: this.control.port,
      blueUpstreamPort: this.manager.gatewayBinding('blue').port,
      greenUpstreamPort: this.manager.gatewayBinding('green').port,
    });
    return this.ingressProcess;
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
    this.ingressProcess = await this.replaceIngressProcess();
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
        rescueEndpoint: `http://${this.ingressProcess.host}:${this.ingressProcess.port}/rescue/mcp`,
      },
    });
    await this.ensureRuntime();
    this.state = this.persist({ observedState: 'healthy' });
    this.monitorTimer = setInterval(() => this.scheduleMonitorTick(), 5_000);
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
      const daemonReleasePath = daemon?.releasePath;
      const daemonReleaseRevision = daemon?.releaseRevision;
      if (identity && (
        identity.generation !== reconciled.generation
        || identity.sourceCommit !== daemonRuntime?.source.commit
        || identity.releasePath !== daemonReleasePath
        || identity.releaseRevision !== daemonReleaseRevision
      )) {
        writeSlotIdentity(this.options.controllerHome, {
          ...identity,
          generation: reconciled.generation,
          ...(daemonRuntime?.source.commit ? { sourceCommit: daemonRuntime.source.commit } : {}),
          releasePath: daemonReleasePath,
          releaseRevision: daemonReleaseRevision,
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

  private async startSlot(slot: RuntimeSlotId, release?: SupervisorReleaseDescriptor): Promise<StartedRuntimeSlot> {
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
      // Candidate slots are passive writers until cutover. They must not drain the
      // shared durable queue. Verify durable-store write/read paths only (queued is OK),
      // matching bluegreen-rollout verifySlotHealth, and rely on daemon/Gateway readiness
      // + generation/tool-surface checks above for process health.
      const requestId = `supervisor-slot-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
      let durableJobId: string;
      try {
        const created = createExecutionJob(daemon.controllerHome, {
          repoId: CONTROLLER_SCOPE_REPO_ID,
          type: 'mcp-tool',
          requestId,
          semanticKey: `supervisor-slot-smoke:${requestId}`,
          payload: {
            operation: 'controller_ready',
            arguments: { repo: this.options.repoRoot },
            target: 'runtime',
          },
          origin: { surface: 'system', actor: 'stable-supervisor-slot-verify' },
          timeoutMs: 30_000,
          maxAttempts: 1,
        });
        durableJobId = created.job.jobId;
        const loaded = getExecutionJob(daemon.controllerHome, CONTROLLER_SCOPE_REPO_ID, durableJobId);
        if (!loaded?.jobId) throw new Error('SUPERVISOR_CANDIDATE_DURABLE_JOB_UNREADABLE');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('SUPERVISOR_CANDIDATE_')) throw error;
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        throw new Error(`SUPERVISOR_CANDIDATE_DURABLE_STORE_FAILED: ${detail}`);
      }
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
      this.persist({
        ingress: {
          ...this.state.ingress,
          state: 'running',
          activeUpstreamSlot: this.state.activeSlot,
          activeUpstreamPort: this.manager.gatewayBinding(this.state.activeSlot).port,
          ...(this.ingressProcess ? { pid: this.ingressProcess.pid } : {}),
          consecutiveFailures: 0,
          lastHealthyAt: new Date().toISOString(),
          lastFailureAt: undefined,
          lastFailureDetail: undefined,
        },
      });
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

  /**
   * A passive candidate starts before authority cutover and therefore holds a
   * deliberately stale writer claim. Once the activation transaction commits,
   * restart the candidate pair so both processes inherit the committed
   * slot/epoch/token before stable ingress is switched.
   */
  private async refreshSlotWriterClaim(input: StartedRuntimeSlot): Promise<StartedRuntimeSlot> {
    const stoppedGateway = await input.manager.stop(input.gatewayHost);
    if (!stoppedGateway.stopped) throw new Error('SUPERVISOR_GATEWAY_WRITER_REFRESH_STOP_INCOMPLETE');
    const stoppedDaemon = await input.manager.stop(input.controllerDaemon);
    if (!stoppedDaemon.stopped) throw new Error('SUPERVISOR_DAEMON_WRITER_REFRESH_STOP_INCOMPLETE');

    let daemon: SupervisorManagedProcess | undefined;
    let gateway: SupervisorManagedProcess | undefined;
    try {
      daemon = processState(await input.manager.startDaemon(), input.controllerDaemon);
      await this.waitForManagedReady(input.manager, 'controllerDaemon', daemon);
      gateway = processState(await input.manager.startGateway(), input.gatewayHost);
      await this.waitForManagedReady(input.manager, 'gatewayHost', gateway);
      const generation = readRuntimeGeneration(daemon.controllerHome)?.generation ?? daemon.generation;
      const gatewayRuntime = loadMcpServiceRuntimeState(gateway.controllerHome, this.options.repoRoot);
      if (!generation || generation !== input.generation) {
        throw new Error(`SUPERVISOR_ACTIVATED_GENERATION_MISMATCH: observed=${generation ?? 'missing'} expected=${input.generation ?? 'missing'}`);
      }
      if (gatewayRuntime?.generation !== generation || gatewayRuntime.server.generation !== generation) {
        throw new Error('SUPERVISOR_ACTIVATED_GATEWAY_GENERATION_MISMATCH');
      }
      return { ...input, generation, controllerDaemon: daemon, gatewayHost: gateway };
    } catch (error) {
      if (gateway) await input.manager.stop(gateway).catch(() => undefined);
      if (daemon) await input.manager.stop(daemon).catch(() => undefined);
      throw error;
    }
  }

  private async rollout(operation: SupervisorOperation): Promise<SupervisorReleaseActivationResult | undefined> {
    const operationId = operation.operationId;
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const previousSlot = authority.activeSlot;
    const candidateSlot = oppositeSlot(previousSlot);
    const previousDaemon = this.state.controllerDaemon;
    const previousGateway = this.state.gatewayHost;
    if (!previousDaemon || !previousGateway) throw new Error('SUPERVISOR_ACTIVE_RUNTIME_MISSING');
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
    let candidateRelease = readCurrentSupervisorRelease(this.options.controllerHome);
    if (operation.candidateReleasePath) {
      const candidatePath = resolve(operation.candidateReleasePath);
      try {
        const releasesRootReal = realpathSync(resolve(supervisorReleasesRoot(this.options.controllerHome)));
        const candidateReal = realpathSync(candidatePath);
        if (!candidateReal.startsWith(`${releasesRootReal}${sep}`)) {
          throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME') throw error;
        throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
      }
      candidateRelease = readSupervisorRelease(candidatePath);
      if (!candidateRelease) throw new Error('SUPERVISOR_STAGED_RELEASE_INVALID');
    }
    const candidate = await this.startSlot(candidateSlot, candidateRelease);
    updateSupervisorOperation(this.options.controllerHome, operationId, {
      phase: 'verifying',
      evidence: [{ kind: 'candidate_verification', summary: `Candidate ${candidateSlot} passed generation, tool-surface, daemon/Gateway readiness, and durable-store write/read verification (${candidate.durableJobId}; consumption deferred until active writer).`, at: new Date().toISOString() }],
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

    let activatedCandidate = candidate;
    let authorityCommitted = false;
    try {
      const nextAuthority = markCutoverAuthority(this.options.controllerHome, candidateSlot, candidate.generation);
      authorityCommitted = true;
      // The candidate was intentionally passive before commit. Restart it with
      // the committed claim while ingress still routes to the previous slot.
      activatedCandidate = await this.refreshSlotWriterClaim(candidate);
      this.persist({
        activeSlot: candidateSlot,
        activeGeneration: activatedCandidate.generation,
        controllerDaemon: activatedCandidate.controllerDaemon,
        gatewayHost: activatedCandidate.gatewayHost,
        previousSlot,
        standby: this.state.standby ? { ...this.state.standby, retainedUntil: nextAuthority.rollbackUntil } : undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: candidateSlot,
          activeUpstreamPort: activatedCandidate.manager.gatewayBinding(candidateSlot).port,
        },
      });
      await this.verifyStableIngress(activatedCandidate.generation);
      writeSlotIdentity(this.options.controllerHome, {
        ...(readSlotIdentity(this.options.controllerHome, candidateSlot) ?? {
          schemaVersion: 1,
          slot: candidateSlot,
          controllerHome: this.options.controllerHome,
          slotHome: activatedCandidate.controllerDaemon.controllerHome,
          mcpPort: activatedCandidate.manager.gatewayBinding(candidateSlot).port,
          localControllerPort: activatedCandidate.localControllerPort,
          updatedAt: new Date().toISOString(),
          logDir: dirname(this.options.logPath),
        }),
        role: 'active',
      });
      const previousIdentity = readSlotIdentity(this.options.controllerHome, previousSlot);
      if (previousIdentity) writeSlotIdentity(this.options.controllerHome, { ...previousIdentity, role: 'standby' });
      updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'cutover' });
      if (!candidateRelease) return undefined;
      if (this.options.activatePublishedRelease === false) {
        publishSupervisorRelease({
          controllerHome: this.options.controllerHome,
          repoRoot: this.options.repoRoot,
          releasePath: candidateRelease.releasePath,
        });
        return undefined;
      }
      return publishAndScheduleSupervisorRelease({
        controllerHome: this.options.controllerHome,
        repoRoot: this.options.repoRoot,
        releasePath: candidateRelease.releasePath,
        handoffDelayMs: 2_000,
      }, this.options.serviceActivationScheduler
        ? { schedule: this.options.serviceActivationScheduler }
        : undefined);
    } catch (error) {
      let restoredDaemon = previousDaemon;
      let restoredGateway = previousGateway;
      if (authorityCommitted) {
        markRollbackAuthority(this.options.controllerHome, previousGeneration);
        const previousTarget: StartedRuntimeSlot = {
          slot: previousSlot,
          generation: previousGeneration,
          manager: this.managerForManaged(previousDaemon, previousSlot),
          controllerDaemon: previousDaemon,
          gatewayHost: previousGateway,
          localControllerPort: loadMcpServiceLocalConfig(previousDaemon.controllerHome, this.options.repoRoot)?.localController?.port ?? 8766,
          durableJobId: 'cutover-rollback-restore',
        };
        const restored = await this.refreshSlotWriterClaim(previousTarget);
        restoredDaemon = restored.controllerDaemon;
        restoredGateway = restored.gatewayHost;
      }
      this.persist({
        activeSlot: previousSlot,
        previousSlot: candidateSlot,
        activeGeneration: previousGeneration,
        controllerDaemon: restoredDaemon,
        gatewayHost: restoredGateway,
        standby: undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: previousSlot,
          activeUpstreamPort: this.managerForManaged(restoredGateway, previousSlot).gatewayBinding(previousSlot).port,
        },
      });
      await this.stopSlotProcesses(activatedCandidate);
      const identity = readSlotIdentity(this.options.controllerHome, candidateSlot);
      if (identity) writeSlotIdentity(this.options.controllerHome, { ...identity, role: 'failed' });
      throw error;
    }
  }

  private async rollback(operationId: string): Promise<SupervisorReleaseActivationResult | undefined> {
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const currentSlot = authority.activeSlot;
    const targetSlot = authority.previousSlot ?? this.state.standby?.slot;
    if (!targetSlot) throw new Error('SUPERVISOR_ROLLBACK_TARGET_MISSING');
    const failedDaemon = this.state.controllerDaemon;
    const failedGateway = this.state.gatewayHost;
    if (!failedDaemon || !failedGateway) throw new Error('SUPERVISOR_ACTIVE_RUNTIME_MISSING');
    let target: StartedRuntimeSlot;
    if (
      this.state.standby?.slot === targetSlot
      && this.manager.observe(this.state.standby.controllerDaemon) === 'alive'
      && this.manager.observe(this.state.standby.gatewayHost) === 'alive'
    ) {
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

    let activatedTarget = target;
    let rollbackAuthorityCommitted = false;
    try {
      markRollbackAuthority(this.options.controllerHome, target.generation);
      rollbackAuthorityCommitted = true;
      activatedTarget = await this.refreshSlotWriterClaim(target);
      this.persist({
        activeSlot: targetSlot,
        activeGeneration: activatedTarget.generation,
        controllerDaemon: activatedTarget.controllerDaemon,
        gatewayHost: activatedTarget.gatewayHost,
        previousSlot: currentSlot,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: targetSlot,
          activeUpstreamPort: activatedTarget.manager.gatewayBinding(targetSlot).port,
        },
      });
      await this.verifyStableIngress(activatedTarget.generation);
    } catch (error) {
      let restoredDaemon = failedDaemon;
      let restoredGateway = failedGateway;
      if (rollbackAuthorityCommitted) {
        markRollbackAuthority(this.options.controllerHome, failedDaemon.generation ?? this.state.activeGeneration);
        const failedTarget: StartedRuntimeSlot = {
          slot: currentSlot,
          generation: failedDaemon.generation ?? this.state.activeGeneration,
          manager: this.managerForManaged(failedDaemon, currentSlot),
          controllerDaemon: failedDaemon,
          gatewayHost: failedGateway,
          localControllerPort: loadMcpServiceLocalConfig(failedDaemon.controllerHome, this.options.repoRoot)?.localController?.port ?? 8766,
          durableJobId: 'rollback-failure-restore',
        };
        const restored = await this.refreshSlotWriterClaim(failedTarget);
        restoredDaemon = restored.controllerDaemon;
        restoredGateway = restored.gatewayHost;
      }
      this.persist({
        activeSlot: currentSlot,
        activeGeneration: failedDaemon.generation,
        controllerDaemon: restoredDaemon,
        gatewayHost: restoredGateway,
        standby: undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: currentSlot,
          activeUpstreamPort: this.managerForManaged(restoredGateway, currentSlot).gatewayBinding(currentSlot).port,
        },
      });
      await this.stopSlotProcesses(activatedTarget);
      throw error;
    }
    await this.stopSlotProcesses({ slot: currentSlot, controllerDaemon: failedDaemon, gatewayHost: failedGateway });
    this.persist({ standby: undefined });
    const targetIdentity = readSlotIdentity(this.options.controllerHome, targetSlot);
    if (targetIdentity) writeSlotIdentity(this.options.controllerHome, { ...targetIdentity, role: 'active' });
    const failedIdentity = readSlotIdentity(this.options.controllerHome, currentSlot);
    if (failedIdentity) writeSlotIdentity(this.options.controllerHome, { ...failedIdentity, role: 'failed' });
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'cutover' });
    const rollbackReleasePath = activatedTarget.controllerDaemon.releasePath;
    if (!rollbackReleasePath) return undefined;
    if (this.options.activatePublishedRelease === false) {
      publishSupervisorRelease({
        controllerHome: this.options.controllerHome,
        repoRoot: this.options.repoRoot,
        releasePath: rollbackReleasePath,
      });
      return undefined;
    }
    return publishAndScheduleSupervisorRelease({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      releasePath: rollbackReleasePath,
      handoffDelayMs: 2_000,
    }, this.options.serviceActivationScheduler
      ? { schedule: this.options.serviceActivationScheduler }
      : undefined);
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
          if (runtime?.status === 'running' && runtime.server.healthy === true) return;
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
    let releaseActivation: SupervisorReleaseActivationResult | undefined;
    let current = updateSupervisorOperation(this.options.controllerHome, operation.operationId, { phase: 'scheduled', scheduledAt: new Date().toISOString() });
    this.persist({ currentOperationId: operation.operationId, observedState: 'degraded' });
    try {
      if (current.kind === 'restart_controller') {
        await this.restartComponent('controllerDaemon', current.operationId);
        // A normal Supervisor-owned daemon restart preserves the writer generation.
        // Keep the Gateway connection stable unless the observed generation really
        // changed; ensureRuntime performs that conditional refresh and verification.
        await this.ensureRuntime();
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
        releaseActivation = await this.rollout(current);
      } else {
        releaseActivation = await this.rollback(current.operationId);
      }
      this.synchronizeActiveRuntimeGeneration(true);
      current = updateSupervisorOperation(this.options.controllerHome, current.operationId, {
        phase: 'succeeded',
        completedAt: new Date().toISOString(),
        result: {
          operationId: current.operationId,
          runtimeGeneration: this.state.activeGeneration,
          reconnectContract: 'stable_domain_retry',
          ...(releaseActivation ? {
            supervisorReleaseRevision: releaseActivation.publication.releaseRevision,
            supervisorActivation: releaseActivation.activation,
          } : {}),
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

  private async recoverComponent(component: SupervisorComponentName, failureReason = `${component} liveness failed`): Promise<void> {
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
        reason: `${failureReason} within the rollback window`,
      });
      this.persist({
        lastIncident: { at: new Date().toISOString(), component, reason: `${failureReason}; automatic rollback accepted`, operationId: accepted.operation.operationId },
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
      reason: failureReason,
    });
    this.persist({
      restartBudget: { ...this.state.restartBudget, [key]: recordRestart(recordFailure(budget, failureReason)) },
      lastIncident: { at: new Date().toISOString(), component, reason: failureReason, operationId: accepted.operation.operationId },
    });
    await this.runPendingOperations();
  }

  private async monitorTick(): Promise<void> {
    if (this.stopping || this.state.desiredState !== 'running') return;
    let degraded = !this.synchronizeActiveRuntimeGeneration(false);
    let ingressDegraded = false;
    if (!this.ingressProcess?.alive()) {
      ingressDegraded = true;
      const now = new Date().toISOString();
      try {
        this.ingressProcess = await this.replaceIngressProcess();
        this.persist({
          ingress: {
            ...this.state.ingress,
            state: 'degraded',
            pid: this.ingressProcess.pid,
            consecutiveFailures: 0,
            lastFailureAt: now,
            lastFailureDetail: 'stable ingress process was not alive and was replaced; awaiting full-path verification',
          },
        });
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
        this.persist({
          ingress: {
            ...this.state.ingress,
            state: 'degraded',
            lastFailureAt: now,
            lastFailureDetail: detail,
          },
          lastIncident: {
            at: now,
            reason: `stable ingress process recovery failed: ${detail}`,
          },
        });
      }
    }
    for (const component of ['controllerDaemon', 'gatewayHost'] as const) {
      const managed = this.componentState(component);
      const observation = this.manager.observe(managed);
      if (observation === 'alive' && managed) {
        if (component === 'gatewayHost') {
          const slot = managed.slot ?? this.state.activeSlot;
          const binding = this.managerForManaged(managed, slot).gatewayBinding(slot);
          const health = await probeSupervisorGatewayHealth(`http://${binding.host}:${binding.port}/ready`);
          if (!health.healthy || health.ready === false) {
            degraded = true;
            if (health.healthy && health.recoveryRecommended !== true) {
              this.setComponent('gatewayHost', {
                ...managed,
                state: 'running',
                lastLivenessAt: new Date().toISOString(),
                consecutiveFailures: 0,
              });
              this.persist({ lastIncident: { at: new Date().toISOString(), component, reason: health.detail } });
              continue;
            }
            const decision = supervisorGatewayHealthDecision(managed.consecutiveFailures, false);
            const consecutiveFailures = decision.consecutiveFailures;
            const failureReason = `gatewayHost readiness probe requires recovery ${consecutiveFailures}/${SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD}: ${health.detail}`;
            this.setComponent('gatewayHost', {
              ...managed,
              state: 'running',
              lastLivenessAt: new Date().toISOString(),
              consecutiveFailures,
            });
            if (decision.shouldRecover) {
              await this.recoverComponent('gatewayHost', failureReason);
            } else {
              this.persist({ lastIncident: { at: new Date().toISOString(), component, reason: failureReason } });
            }
            continue;
          }
        }
        const key = managedKey(component, managed.generation ?? this.state.activeGeneration);
        const budget = this.state.restartBudget[key];
        const healthyManaged = {
          ...managed,
          state: 'running' as const,
          lastLivenessAt: new Date().toISOString(),
          consecutiveFailures: 0,
        };
        this.persist({
          ...(budget ? { restartBudget: { ...this.state.restartBudget, [key]: recordStable(budget) } } : {}),
          ...(component === 'controllerDaemon' ? { controllerDaemon: healthyManaged } : { gatewayHost: healthyManaged }),
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
      const gatewayAlive = this.manager.observe(this.state.gatewayHost) === 'alive';
      const gatewayHealthy = gatewayAlive
        && this.state.gatewayHost?.state === 'running'
        && this.state.gatewayHost.consecutiveFailures === 0;
      const operationActive = Boolean(this.state.currentOperationId);
      let ingressPathHealthy = false;
      if (gatewayHealthy && this.ingressProcess?.alive()) {
        if (operationActive) {
          ingressPathHealthy = this.state.ingress.state === 'running'
            && (this.state.ingress.consecutiveFailures ?? 0) === 0;
        } else {
          const ingressEndpoint = `http://${this.ingressProcess.host}:${this.ingressProcess.port}/ready`;
          const health = await probeSupervisorGatewayHealth(ingressEndpoint);
          const decision = supervisorIngressHealthDecision(
            this.state.ingress.consecutiveFailures ?? 0,
            health.healthy,
          );
          if (health.healthy) {
            ingressPathHealthy = true;
            ingressDegraded = false;
            this.persist({
              ingress: {
                ...this.state.ingress,
                state: 'running',
                activeUpstreamSlot: this.state.activeSlot,
                activeUpstreamPort: this.manager.gatewayBinding(this.state.activeSlot).port,
                pid: this.ingressProcess.pid,
                consecutiveFailures: 0,
                lastHealthyAt: new Date().toISOString(),
              },
            });
          } else {
            ingressDegraded = true;
            const now = new Date().toISOString();
            const failureReason = `stable ingress full-path probe failed ${decision.consecutiveFailures}/${SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD} slot=${this.state.activeSlot} targetPort=${this.manager.gatewayBinding(this.state.activeSlot).port}: ${health.detail}`;
            if (decision.shouldReplace) {
              const previousPid = this.ingressProcess.pid;
              try {
                this.ingressProcess = await this.replaceIngressProcess();
                const replacementHealth = await probeSupervisorGatewayHealth(
                  `http://${this.ingressProcess.host}:${this.ingressProcess.port}/ready`,
                );
                if (replacementHealth.healthy) {
                  ingressPathHealthy = true;
                  ingressDegraded = false;
                  this.persist({
                    ingress: {
                      ...this.state.ingress,
                      state: 'running',
                      activeUpstreamSlot: this.state.activeSlot,
                      activeUpstreamPort: this.manager.gatewayBinding(this.state.activeSlot).port,
                      pid: this.ingressProcess.pid,
                      consecutiveFailures: 0,
                      lastHealthyAt: new Date().toISOString(),
                    },
                    lastIncident: {
                      at: now,
                      reason: `stable ingress false-health recovered by process replacement oldPid=${previousPid} newPid=${this.ingressProcess.pid}`,
                    },
                  });
                } else {
                  const replacementDetail = `replacement full-path probe failed: ${replacementHealth.detail}`;
                  this.persist({
                    ingress: {
                      ...this.state.ingress,
                      state: 'degraded',
                      pid: this.ingressProcess.pid,
                      consecutiveFailures: 1,
                      lastFailureAt: now,
                      lastFailureDetail: replacementDetail,
                    },
                    lastIncident: { at: now, reason: replacementDetail },
                  });
                }
              } catch (error) {
                const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
                this.persist({
                  ingress: {
                    ...this.state.ingress,
                    state: 'degraded',
                    consecutiveFailures: decision.consecutiveFailures,
                    lastFailureAt: now,
                    lastFailureDetail: detail,
                  },
                  lastIncident: { at: now, reason: `stable ingress replacement failed: ${detail}` },
                });
              }
            } else {
              this.persist({
                ingress: {
                  ...this.state.ingress,
                  state: 'degraded',
                  pid: this.ingressProcess.pid,
                  consecutiveFailures: decision.consecutiveFailures,
                  lastFailureAt: now,
                  lastFailureDetail: health.detail,
                },
                lastIncident: { at: now, reason: failureReason },
              });
            }
          }
        }
      } else {
        ingressDegraded = true;
      }
      const stableIngressHealthy = gatewayHealthy && ingressPathHealthy && !ingressDegraded;
      this.persist({
        observedState: degraded || ingressDegraded || operationActive ? 'degraded' : 'healthy',
        ingress: {
          ...this.state.ingress,
          state: stableIngressHealthy ? 'running' : 'degraded',
        },
      });
    }
    await this.runPendingOperations();
    await this.cleanupExpiredStandby();
  }

  private scheduleMonitorTick(): void {
    if (this.monitorPromise) return;
    const run = this.monitorTick();
    this.monitorPromise = run;
    void run.finally(() => {
      if (this.monitorPromise === run) this.monitorPromise = undefined;
    }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    await this.monitorPromise?.catch(() => undefined);
    this.persist({ desiredState: 'stopped', observedState: 'stopped' });
    await this.stopComponent('gatewayHost');
    await this.stopComponent('controllerDaemon');
    if (this.state.standby) await this.stopSlotProcesses(this.state.standby);
    this.persist({ standby: undefined });
    if (this.ingressProcess) await this.ingressProcess.close();
    this.ingressProcess = undefined;
    if (this.control) await this.control.close();
    this.control = undefined;
    this.persist({ currentOperationId: null, ingress: { ...this.state.ingress, state: 'stopped' } });
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
