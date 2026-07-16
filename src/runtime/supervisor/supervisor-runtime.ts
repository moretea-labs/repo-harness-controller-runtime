import { loadMcpServiceRuntimeState } from '../../cli/mcp/auth';
import { controllerRollback, controllerRollout } from '../../cli/controller/bluegreen-rollout';
import { readControllerDaemonStatus } from '../control-plane/daemon-client';
import { readRuntimeGeneration } from '../control-plane/runtime-generation';
import { createSupervisorControlServer, type SupervisorControlServerHandle, type SupervisorControlHandlers } from './control-server';
import { createSupervisorOperation, listSupervisorOperations, readSupervisorOperation, updateSupervisorOperation } from './operation-store';
import { decideRestart, lockout, newRestartBudgetRecord, recordFailure, recordRestart, recordStable } from './restart-policy';
import { SupervisorProcessManager, type SpawnedSupervisorProcess, type SupervisorProcessManagerOptions } from './process-manager';
import { createSupervisorState, readSupervisorState, writeSupervisorState } from './state-store';
import { supervisorControlSocketPath } from './paths';
import type { SupervisorComponentName, SupervisorManagedProcess, SupervisorOperation, SupervisorOperationKind, SupervisorState } from './types';

export interface StableSupervisorRuntimeOptions extends SupervisorProcessManagerOptions {
  controlHost?: string;
  controlPort?: number;
  rescueAuthToken?: string;
  releaseRevision?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function processState(spawned: SpawnedSupervisorProcess, previous?: SupervisorManagedProcess): SupervisorManagedProcess {
  const now = new Date().toISOString();
  return {
    ...spawned.identity,
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

export class StableSupervisorRuntime implements SupervisorControlHandlers {
  readonly options: StableSupervisorRuntimeOptions;
  readonly manager: SupervisorProcessManager;
  private state: SupervisorState;
  private control?: SupervisorControlServerHandle;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private executionPromise?: Promise<void>;
  private stopping = false;

  constructor(options: StableSupervisorRuntimeOptions) {
    this.options = options;
    this.manager = new SupervisorProcessManager(options);
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
    this.state = {
      ...this.state,
      supervisor: { ...identity, ...(releaseRevision ? { releaseRevision } : {}) },
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
    writeSupervisorState(this.options.controllerHome, this.state);
    this.control = await createSupervisorControlServer({
      controllerHome: this.options.controllerHome,
      controlHost: this.options.controlHost,
      controlPort: this.options.controlPort,
      authToken: this.options.rescueAuthToken,
      handlers: this,
    });
    this.state = this.persist({
      ingress: { ...this.state.ingress, state: 'running' },
      control: {
        host: this.control.host,
        port: this.control.port,
        socketPath: supervisorControlSocketPath(this.options.controllerHome),
        rescueEndpoint: `http://${this.control.host}:${this.control.port}/rescue/mcp`,
      },
    });
    await this.ensureRuntime();
    this.state = this.persist({ observedState: 'healthy' });
    this.monitorTimer = setInterval(() => { void this.monitorTick(); }, 5_000);
    this.monitorTimer.unref?.();
    await this.runPendingOperations();
  }

  private persist(patch: Partial<SupervisorState>): SupervisorState {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    writeSupervisorState(this.options.controllerHome, this.state);
    return this.state;
  }

  private componentState(component: SupervisorComponentName): SupervisorManagedProcess | undefined {
    return component === 'controllerDaemon' ? this.state.controllerDaemon : this.state.gatewayHost;
  }

  private setComponent(component: SupervisorComponentName, value: SupervisorManagedProcess | undefined): void {
    if (component === 'controllerDaemon') this.persist({ controllerDaemon: value });
    else this.persist({ gatewayHost: value });
  }

  private async ensureRuntime(): Promise<void> {
    if (this.stopping || this.state.desiredState !== 'running') return;
    if (!this.state.controllerDaemon || this.manager.observe(this.state.controllerDaemon) !== 'alive') {
      const started = await this.manager.startDaemon();
      this.setComponent('controllerDaemon', processState(started, this.state.controllerDaemon));
    }
    if (!this.state.gatewayHost || this.manager.observe(this.state.gatewayHost) !== 'alive') {
      const started = await this.manager.startGateway();
      this.setComponent('gatewayHost', processState(started, this.state.gatewayHost));
    }
    this.persist({
      activeGeneration: readRuntimeGeneration(this.options.controllerHome)?.generation ?? this.state.activeGeneration,
      observedState: 'healthy',
    });
  }

  private async waitForReady(component: SupervisorComponentName): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const managed = this.componentState(component);
      if (managed && this.manager.observe(managed) === 'alive') {
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
    const result = await this.manager.stop(current);
    if (!result.stopped) throw new Error(`SUPERVISOR_${component.toUpperCase()}_STOP_INCOMPLETE`);
    this.setComponent(component, { ...current, state: 'stopped', lastLivenessAt: new Date().toISOString() });
  }

  private async restartComponent(component: SupervisorComponentName, operationId: string): Promise<void> {
    const current = this.componentState(component);
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'stopping', startedAt: new Date().toISOString() });
    if (current) await this.stopComponent(component);
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
    const started = component === 'controllerDaemon' ? await this.manager.startDaemon() : await this.manager.startGateway();
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
      } else {
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: current.kind === 'rollout' ? 'switching_ingress' : 'rolling_back' });
        const result = current.kind === 'rollout'
          ? await controllerRollout({ repo: this.options.repoRoot, controllerHome: this.options.controllerHome, skipDurableJob: true, reason: current.reason })
          : await controllerRollback({ repo: this.options.repoRoot, controllerHome: this.options.controllerHome, skipDurableJob: true });
        if (result.status === 'failed') throw new Error(`SUPERVISOR_${current.kind.toUpperCase()}_FAILED`);
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'cutover', result: { status: result.status } });
        await this.ensureRuntime();
      }
      current = updateSupervisorOperation(this.options.controllerHome, current.operationId, {
        phase: 'succeeded',
        completedAt: new Date().toISOString(),
        result: {
          operationId: current.operationId,
          runtimeGeneration: readRuntimeGeneration(this.options.controllerHome)?.generation,
          reconnectContract: 'stable_domain_retry',
        },
      });
      this.persist({ currentOperationId: null, observedState: 'healthy', activeGeneration: readRuntimeGeneration(this.options.controllerHome)?.generation ?? this.state.activeGeneration });
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
    const generation = managed.generation ?? this.state.activeGeneration;
    const key = managedKey(component, generation);
    const budget = this.state.restartBudget[key] ?? newRestartBudgetRecord(component, generation);
    const decision = decideRestart(budget);
    if (!decision.allowed) {
      this.persist({
        observedState: 'locked_out',
        restartBudget: { ...this.state.restartBudget, [key]: lockout(budget, decision.reason ?? 'restart budget exhausted') },
        lastIncident: { at: new Date().toISOString(), component, reason: decision.reason ?? 'restart budget exhausted' },
      });
      return;
    }
    const requestId = `auto-recover:${component}:${generation ?? 'unknown'}:${Math.floor(Date.now() / 60_000)}`;
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
    for (const component of ['controllerDaemon', 'gatewayHost'] as const) {
      const managed = this.componentState(component);
      const observation = this.manager.observe(managed);
      if (observation === 'alive' && managed) {
        const key = managedKey(component, managed.generation ?? this.state.activeGeneration);
        const budget = this.state.restartBudget[key];
        this.persist({
          observedState: 'healthy',
          ...(budget ? { restartBudget: { ...this.state.restartBudget, [key]: recordStable(budget) } } : {}),
          ...(component === 'controllerDaemon' ? { controllerDaemon: { ...managed, lastLivenessAt: new Date().toISOString() } } : { gatewayHost: { ...managed, lastLivenessAt: new Date().toISOString() } }),
        });
      } else if (observation === 'dead') {
        await this.recoverComponent(component);
      } else if (observation === 'unknown') {
        this.persist({ observedState: 'degraded', lastIncident: { at: new Date().toISOString(), component, reason: 'process identity could not be proven; process retained' } });
      }
    }
    await this.runPendingOperations();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.persist({ desiredState: 'stopped', observedState: 'stopped' });
    await this.stopComponent('gatewayHost');
    await this.stopComponent('controllerDaemon');
    if (this.control) await this.control.close();
    this.control = undefined;
    this.persist({ currentOperationId: null });
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
