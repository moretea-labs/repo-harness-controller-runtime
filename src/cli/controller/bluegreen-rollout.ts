import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { writeMcpServiceLocalConfig, loadMcpServiceLocalConfig, type McpLocalConfig } from '../mcp/auth';
import { resolveMcpRepoRoot } from '../mcp/repo';
import { resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import {
  controllerServiceStatus,
  startControllerService,
  stopControllerService,
  type ControllerServiceStatus,
} from './lifecycle';
import {
  allocateSlotPorts,
  ensureSlotHome,
  markCutoverAuthority,
  markRollbackAuthority,
  oppositeSlot,
  readActiveSlotAuthority,
  readSlotIdentity,
  writeSlotIdentity,
  type RuntimeSlotId,
  type SlotIdentity,
} from './runtime-slots';
import {
  boundKeyOutput,
  compositeFailed,
  compositeSucceeded,
  type CompositeToolResult,
} from './composite-result';
import { readRuntimeGeneration } from '../../runtime/control-plane/runtime-generation';
import { createExecutionJob, getExecutionJob } from '../../runtime/execution/jobs/store';
import { CONTROLLER_SCOPE_REPO_ID } from '../repositories/controller-home';
import { randomUUID } from 'crypto';
import { isStableSupervisorInstalled, readPreviousRelease } from '../../runtime/supervisor/paths';
import { publishSupervisorRelease, stageSupervisorRelease } from '../../runtime/supervisor/installer';
import { resolveControllerRuntimeSourceRoot } from '../../runtime/control-plane/runtime-generation';
import { sendSupervisorCommand } from '../../runtime/supervisor/control-server';
import { readStableSupervisorState } from '../../runtime/supervisor/bridge';
import type { SupervisorOperation, SupervisorOperationKind } from '../../runtime/supervisor/types';
import { scheduleServiceActivation } from '../commands/supervisor';

export interface BlueGreenRolloutOptions {
  repo?: string;
  controllerHome?: string;
  /** Force ports for inactive/candidate slot (tests inject free ports). */
  candidatePorts?: { mcpPort: number; localControllerPort: number };
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  skipDurableJob?: boolean;
  skipRestartDurability?: boolean;
  reason?: string;
}

const TERMINAL_SUPERVISOR_PHASES = new Set(['succeeded', 'failed', 'locked_out']);

function operationTimeoutMs(opts: BlueGreenRolloutOptions): number {
  return Math.max(180_000, (opts.startTimeoutMs ?? 60_000) * 3);
}

async function submitAndWaitSupervisorOperation(input: {
  rootHome: string;
  kind: SupervisorOperationKind;
  reason?: string;
  candidateReleasePath?: string;
  timeoutMs: number;
}): Promise<SupervisorOperation> {
  const requestId = `controller-${input.kind}-${Date.now()}-${randomUUID().slice(0, 10)}`;
  const submitted = await sendSupervisorCommand(input.rootHome, {
    command: 'operation_submit',
    requestId,
    kind: input.kind,
    actor: 'controller-bluegreen-rollout',
    reason: input.reason,
    candidateReleasePath: input.candidateReleasePath,
  });
  if (!submitted.ok || !submitted.operation) {
    throw new Error(submitted.error?.message ?? 'SUPERVISOR_OPERATION_REJECTED');
  }
  if (input.candidateReleasePath && submitted.operation.candidateReleasePath !== input.candidateReleasePath) {
    throw new Error('SUPERVISOR_STAGED_ROLLOUT_CAPABILITY_MISMATCH');
  }
  let operation = submitted.operation;
  const deadline = Date.now() + input.timeoutMs;
  while (!TERMINAL_SUPERVISOR_PHASES.has(operation.phase)) {
    if (Date.now() >= deadline) {
      throw new Error(`SUPERVISOR_OPERATION_TIMEOUT: ${operation.operationId} phase=${operation.phase}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const polled = await sendSupervisorCommand(input.rootHome, {
      command: 'operation_get',
      operationId: operation.operationId,
    });
    if (!polled.ok || !polled.operation) {
      throw new Error(polled.error?.message ?? 'SUPERVISOR_OPERATION_READ_FAILED');
    }
    operation = polled.operation;
  }
  return operation;
}

function partialResult(input: {
  phase: string;
  summary: string;
  keyOutput: string;
  nextAction: string;
  details?: Record<string, unknown>;
}): CompositeToolResult {
  return {
    status: 'partial',
    phase: input.phase,
    summary: input.summary,
    keyOutput: boundKeyOutput(input.keyOutput),
    evidenceRefs: [],
    retryable: true,
    nextAction: input.nextAction,
    details: input.details,
  };
}

function supportsStagedRolloutRelease(rootHome: string): boolean {
  const releasePath = readStableSupervisorState(rootHome)?.supervisor.releasePath;
  if (!releasePath) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(releasePath, 'manifest.json'), 'utf8')) as { capabilities?: unknown };
    return Array.isArray(manifest.capabilities) && manifest.capabilities.includes('staged_rollout_release');
  } catch {
    return false;
  }
}

async function stableSupervisorRollout(
  repoRoot: string,
  rootHome: string,
  opts: BlueGreenRolloutOptions,
): Promise<CompositeToolResult> {
  if (!supportsStagedRolloutRelease(rootHome)) {
    return compositeFailed({
      phase: 'supervisor-capability',
      summary: 'The running Stable Supervisor cannot safely consume an unpublished candidate release',
      failedCheck: 'staged_rollout_release',
      keyOutput: 'running Supervisor release lacks staged_rollout_release capability',
      retryable: false,
      nextAction: 'install and activate the current Supervisor release first, then retry rollout',
    });
  }
  const source = resolveControllerRuntimeSourceRoot();
  let staged;
  try {
    staged = stageSupervisorRelease({
      controllerHome: rootHome,
      repoRoot,
      sourceRoot: source.root ?? repoRoot,
    });
  } catch (error) {
    return compositeFailed({
      phase: 'release-stage',
      summary: 'Failed to build an isolated candidate Supervisor release',
      failedCheck: 'candidate_release_build',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'fix the candidate build; active Supervisor and slot authority were not changed',
    });
  }

  let operation: SupervisorOperation;
  try {
    operation = await submitAndWaitSupervisorOperation({
      rootHome,
      kind: 'rollout',
      reason: opts.reason,
      candidateReleasePath: staged.releasePath,
      timeoutMs: operationTimeoutMs(opts),
    });
  } catch (error) {
    return compositeFailed({
      phase: 'supervisor-rollout',
      summary: 'Root Stable Supervisor did not complete candidate rollout',
      failedCheck: 'supervisor_operation',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'inspect the durable Supervisor operation; the staged release was never published',
      details: { stagedRelease: staged },
    });
  }
  if (operation.phase !== 'succeeded') {
    return compositeFailed({
      phase: operation.phase,
      summary: 'Candidate verification or cutover failed; active release publication was skipped',
      failedCheck: operation.failureClass ?? 'supervisor_rollout',
      keyOutput: operation.error ?? `operation ${operation.operationId} ended in ${operation.phase}`,
      nextAction: 'inspect candidate evidence and retry after fixing the release',
      details: { operation, stagedRelease: staged },
    });
  }

  let publication;
  try {
    publication = publishSupervisorRelease({
      controllerHome: rootHome,
      repoRoot,
      releasePath: staged.releasePath,
    });
  } catch (error) {
    let rollback: SupervisorOperation | undefined;
    try {
      rollback = await submitAndWaitSupervisorOperation({
        rootHome,
        kind: 'rollback',
        reason: 'candidate cutover succeeded but release publication failed',
        timeoutMs: operationTimeoutMs(opts),
      });
    } catch {
      // Report both the publication failure and best-effort rollback uncertainty.
    }
    return compositeFailed({
      phase: 'release-publish',
      summary: 'Candidate cutover succeeded but root release publication failed',
      failedCheck: 'release_publish',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'inspect Supervisor authority and rollback outcome before retrying',
      details: { operation, rollback, stagedRelease: staged },
    });
  }

  let activation: ReturnType<typeof scheduleServiceActivation> | { skipped: true };
  try {
    activation = opts.skipRestartDurability
      ? { skipped: true }
      : scheduleServiceActivation(repoRoot, rootHome, 3_000);
  } catch (error) {
    return partialResult({
      phase: 'activation-schedule',
      summary: 'Rollout and release publication succeeded, but Supervisor self-activation was not scheduled',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'run supervisor install --register-service for the published release; do not repeat rollout',
      details: { operation, publication },
    });
  }

  const authority = readActiveSlotAuthority(rootHome);
  return compositeSucceeded({
    phase: 'cutover',
    summary: `Rollout complete under one Stable Supervisor: active slot is ${authority.activeSlot}`,
    keyOutput: [
      `operation=${operation.operationId}`,
      `active=${authority.activeSlot}`,
      `generation=${authority.generation ?? 'unknown'}`,
      `release=${publication.releaseRevision}`,
      `activation=${'skipped' in activation ? 'skipped' : activation.activationId}`,
    ].join('\n'),
    nextAction: 'retry the stable domain while detached Supervisor activation completes',
    details: { authority, operation, publication, activation },
  });
}

async function stableSupervisorRollback(
  repoRoot: string,
  rootHome: string,
  opts: BlueGreenRolloutOptions,
): Promise<CompositeToolResult> {
  const supervisorState = readStableSupervisorState(rootHome);
  const rollbackReleasePath = supervisorState?.standby?.controllerDaemon.releasePath
    ?? readPreviousRelease(rootHome);
  let operation: SupervisorOperation;
  try {
    operation = await submitAndWaitSupervisorOperation({
      rootHome,
      kind: 'rollback',
      reason: opts.reason,
      timeoutMs: operationTimeoutMs(opts),
    });
  } catch (error) {
    return compositeFailed({
      phase: 'supervisor-rollback',
      summary: 'Root Stable Supervisor did not complete rollback',
      failedCheck: 'supervisor_operation',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'inspect the durable Supervisor rollback operation',
    });
  }
  if (operation.phase !== 'succeeded') {
    return compositeFailed({
      phase: operation.phase,
      summary: 'Supervisor rollback failed',
      failedCheck: operation.failureClass ?? 'supervisor_rollback',
      keyOutput: operation.error ?? `operation ${operation.operationId} ended in ${operation.phase}`,
      nextAction: 'inspect rollback evidence before retrying',
      details: { operation },
    });
  }
  if (!rollbackReleasePath) {
    return partialResult({
      phase: 'rollback-release',
      summary: 'Slot rollback succeeded, but the previous immutable release could not be identified',
      keyOutput: `operation=${operation.operationId}`,
      nextAction: 'inspect slot identity and Supervisor release pointers before restarting',
      details: { operation },
    });
  }

  let publication;
  try {
    publication = publishSupervisorRelease({ controllerHome: rootHome, repoRoot, releasePath: rollbackReleasePath });
  } catch (error) {
    return partialResult({
      phase: 'rollback-release',
      summary: 'Slot rollback succeeded, but the previous release could not be republished',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'repair the current/previous release pointers before Supervisor restart',
      details: { operation, rollbackReleasePath },
    });
  }

  let activation: ReturnType<typeof scheduleServiceActivation> | { skipped: true };
  try {
    activation = opts.skipRestartDurability
      ? { skipped: true }
      : scheduleServiceActivation(repoRoot, rootHome, 3_000);
  } catch (error) {
    return partialResult({
      phase: 'rollback-activation',
      summary: 'Rollback and release publication succeeded, but Supervisor self-activation was not scheduled',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'activate the published previous release without repeating rollback',
      details: { operation, publication },
    });
  }

  const authority = readActiveSlotAuthority(rootHome);
  return compositeSucceeded({
    phase: 'rollback',
    summary: `Rollback complete under one Stable Supervisor: active slot is ${authority.activeSlot}`,
    keyOutput: [
      `operation=${operation.operationId}`,
      `active=${authority.activeSlot}`,
      `release=${publication.releaseRevision}`,
      `activation=${'skipped' in activation ? 'skipped' : activation.activationId}`,
    ].join('\n'),
    nextAction: 'retry the stable domain while detached Supervisor activation completes',
    details: { authority, operation, publication, activation },
  });
}

export interface SlotVerification {
  ok: boolean;
  phase: string;
  failures: string[];
  status?: ControllerServiceStatus;
  generation?: string;
  sourceCommit?: string;
  toolFingerprint?: string;
  durableJobId?: string;
}

function writeSlotConfig(
  slotHome: string,
  ports: { mcpPort: number; localControllerPort: number },
  template: McpLocalConfig | null,
): void {
  const next: McpLocalConfig = {
    version: 1,
    profile: template?.profile ?? 'controller',
    toolset: template?.toolset ?? 'core',
    auth: template?.auth ?? { mode: 'bearer' },
    server: {
      host: template?.server?.host ?? '127.0.0.1',
      port: ports.mcpPort,
    },
    localController: {
      enabled: true,
      host: template?.localController?.host ?? '127.0.0.1',
      port: ports.localControllerPort,
      autoOpen: false,
    },
    devMode: template?.devMode,
    chatgpt: template?.chatgpt,
  };
  writeMcpServiceLocalConfig(slotHome, next);
}

export async function verifySlotHealth(
  repoRoot: string,
  slotHome: string,
  opts: {
    requireGeneration?: string;
    expectedSourceCommit?: string;
    skipDurableJob?: boolean;
  } = {},
): Promise<SlotVerification> {
  const failures: string[] = [];
  let phase = 'status';
  const status = await controllerServiceStatus({ repo: repoRoot, controllerHome: slotHome, slotLocalLifecycle: true });
  if (!status.supervisor.alive) failures.push('supervisor not alive');
  if (!status.health.mcp) failures.push('gateway health failed');
  if (!status.health.localController) failures.push('local controller health failed');
  if (status.daemon.status !== 'ready') failures.push(`daemon status=${status.daemon.status}`);
  if (status.daemon.degraded) failures.push(`daemon degraded: ${status.daemon.error ?? 'unknown'}`);
  if (!status.readiness.scheduler) failures.push('scheduler not healthy');
  if (!status.runtimeGeneration) failures.push('runtime generation missing');
  if (opts.requireGeneration && status.runtimeGeneration !== opts.requireGeneration) {
    failures.push(`generation ${status.runtimeGeneration} != required ${opts.requireGeneration}`);
  }
  const sourceCommit = status.runtimeSource?.commit;
  if (opts.expectedSourceCommit && sourceCommit && sourceCommit !== opts.expectedSourceCommit) {
    failures.push(`source commit ${sourceCommit} != ${opts.expectedSourceCommit}`);
  }
  const toolFingerprint = status.mcpRuntime?.server.toolSurfaceFingerprint
    ?? status.mcpRuntime?.server.runtimeToolSurfaceFingerprint;
  // Only fail on true worker/daemon orphans for THIS slot. Sibling-slot supervisors,
  // tunnels, and generic "unknown" processes that merely share a repo path are noise
  // during blue/green operation and must not block cutover.
  const workerOrphans = status.orphanedProcesses.filter((entry) => {
    if (entry.pid === status.supervisor.pid) return false;
    if (entry.kind === 'controller-daemon' && entry.pid === status.daemon.pid) return false;
    if (entry.kind === 'tunnel-supervisor' || entry.kind === 'tunnel-worker' || entry.kind === 'tunnel-client') {
      return false;
    }
    if (entry.kind === 'unknown') {
      return /(?:^|[\s/])(?:worker|agent-job|execution-job|daemon-entry)(?:[\s.]|$)/i.test(entry.command);
    }
    // Managed kinds outside the tracked supervisor for this slot home.
    return entry.kind === 'mcp-keepalive'
      || entry.kind === 'mcp-serve'
      || entry.kind === 'local-controller'
      || entry.kind === 'supervisor'
      || entry.kind === 'controller-daemon';
  });
  if (workerOrphans.length > 0) {
    failures.push(`orphan workers: ${workerOrphans.map((p) => `${p.kind}:${p.pid}`).join(',')}`);
  }

  let durableJobId: string | undefined;
  if (!opts.skipDurableJob && failures.length === 0) {
    phase = 'durable-job';
    try {
      const requestId = `bg-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const created = createExecutionJob(slotHome, {
        repoId: CONTROLLER_SCOPE_REPO_ID,
        type: 'mcp-tool',
        requestId,
        semanticKey: `bluegreen-smoke:${requestId}`,
        payload: {
          operation: 'controller_ready',
          arguments: { repo: repoRoot },
          target: 'runtime',
        },
        origin: {
          surface: 'system',
          actor: 'bluegreen-verify',
        },
        timeoutMs: 30_000,
        maxAttempts: 1,
      });
      durableJobId = created.job.jobId;
      const loaded = getExecutionJob(slotHome, CONTROLLER_SCOPE_REPO_ID, created.job.jobId);
      if (!loaded?.jobId) failures.push('durable job not readable after create');
    } catch (error) {
      failures.push(`durable job failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: failures.length === 0,
    phase,
    failures,
    status,
    generation: status.runtimeGeneration,
    sourceCommit,
    toolFingerprint,
    durableJobId,
  };
}

export async function startInactiveSlot(
  opts: BlueGreenRolloutOptions = {},
): Promise<{ slot: RuntimeSlotId; slotHome: string; identity: SlotIdentity; verification: SlotVerification }> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const rootHome = resolveRepoPreferredControllerHome(repoRoot, opts.controllerHome);
  const authority = readActiveSlotAuthority(rootHome);
  const active = authority.activeSlot;
  const candidate = oppositeSlot(active);
  const activeHome = ensureSlotHome(rootHome, active);
  const candidateHome = ensureSlotHome(rootHome, candidate);

  // Bootstrap active slot config from legacy root if needed so active remains stable.
  const rootConfig = loadMcpServiceLocalConfig(rootHome, repoRoot);
  if (rootConfig && !loadMcpServiceLocalConfig(activeHome, repoRoot)) {
    writeSlotConfig(activeHome, {
      mcpPort: rootConfig.server?.port ?? 8765,
      localControllerPort: rootConfig.localController?.port ?? 8766,
    }, rootConfig);
  }

  const basePorts = {
    mcpPort: rootConfig?.server?.port
      ?? loadMcpServiceLocalConfig(activeHome, repoRoot)?.server?.port
      ?? 8765,
    localControllerPort: rootConfig?.localController?.port
      ?? loadMcpServiceLocalConfig(activeHome, repoRoot)?.localController?.port
      ?? 8766,
  };
  const ports = allocateSlotPorts(candidate, active, basePorts, opts.candidatePorts);
  writeSlotConfig(candidateHome, ports, loadMcpServiceLocalConfig(activeHome, repoRoot) ?? rootConfig);

  // Ensure active is not sharing candidate home.
  if (activeHome === candidateHome) {
    throw new Error('BLUEGREEN_SLOT_COLLISION: active and candidate share the same slot home');
  }

  const activePorts = {
    mcpPort: loadMcpServiceLocalConfig(activeHome, repoRoot)?.server?.port
      ?? rootConfig?.server?.port
      ?? 8765,
    localControllerPort: loadMcpServiceLocalConfig(activeHome, repoRoot)?.localController?.port
      ?? rootConfig?.localController?.port
      ?? 8766,
  };
  if (ports.mcpPort === activePorts.mcpPort || ports.localControllerPort === activePorts.localControllerPort) {
    const identity = writeSlotIdentity(rootHome, {
      schemaVersion: 1,
      slot: candidate,
      role: 'failed',
      controllerHome: rootHome,
      slotHome: candidateHome,
      mcpPort: ports.mcpPort,
      localControllerPort: ports.localControllerPort,
      updatedAt: new Date().toISOString(),
      logDir: join(candidateHome, 'logs'),
    });
    return {
      slot: candidate,
      slotHome: candidateHome,
      identity,
      verification: {
        ok: false,
        phase: 'port-preflight',
        failures: [
          `candidate ports collide with active slot (mcp=${ports.mcpPort}, local=${ports.localControllerPort})`,
        ],
      },
    };
  }

  let startError: string | undefined;
  try {
    await startControllerService({
      repo: repoRoot,
      controllerHome: candidateHome,
      startTimeoutMs: opts.startTimeoutMs,
      logFile: join(candidateHome, 'logs', 'controller.log'),
      slotLocalLifecycle: true,
    });
  } catch (error) {
    startError = error instanceof Error ? error.message : String(error);
  }

  const verification = startError
    ? {
      ok: false as const,
      phase: 'green-start',
      failures: [startError],
    }
    : await verifySlotHealth(repoRoot, candidateHome, {
      skipDurableJob: opts.skipDurableJob,
    });
  const generation = readRuntimeGeneration(candidateHome)?.generation ?? verification.generation;
  const identity = writeSlotIdentity(rootHome, {
    schemaVersion: 1,
    slot: candidate,
    role: verification.ok ? 'candidate' : 'failed',
    controllerHome: rootHome,
    slotHome: candidateHome,
    mcpPort: ports.mcpPort,
    localControllerPort: ports.localControllerPort,
    generation,
    sourceCommit: verification.sourceCommit,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logDir: join(candidateHome, 'logs'),
  });

  if (!verification.ok) {
    try {
      await stopControllerService({
        repo: repoRoot,
        controllerHome: candidateHome,
        stopTimeoutMs: opts.stopTimeoutMs,
        protectCallerAncestry: false,
        requireFullStop: true,
        slotLocalLifecycle: true,
      });
    } catch {
      // retain verification failure as primary
    }
  }

  return { slot: candidate, slotHome: candidateHome, identity, verification };
}

export async function controllerRollout(opts: BlueGreenRolloutOptions = {}): Promise<CompositeToolResult> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const rootHome = resolveRepoPreferredControllerHome(repoRoot, opts.controllerHome);
  if (isStableSupervisorInstalled(rootHome)) {
    return stableSupervisorRollout(repoRoot, rootHome, opts);
  }
  const authority = readActiveSlotAuthority(rootHome);
  const active = authority.activeSlot;
  const activeHome = ensureSlotHome(rootHome, active);

  // Ensure active slot is running under its isolated home when slots are in use.
  // For first rollout from legacy single-home, migrate config into active slot.
  const rootConfig = loadMcpServiceLocalConfig(rootHome, repoRoot);
  if (rootConfig) {
    writeSlotConfig(activeHome, {
      mcpPort: rootConfig.server?.port ?? 8765,
      localControllerPort: rootConfig.localController?.port ?? 8766,
    }, rootConfig);
  }

  const activeBefore = await controllerServiceStatus({ repo: repoRoot, controllerHome: activeHome, slotLocalLifecycle: true });
  const activeReadyBefore = activeBefore.ready || activeBefore.running;

  let started;
  try {
    started = await startInactiveSlot(opts);
  } catch (error) {
    return compositeFailed({
      phase: 'green-start',
      summary: 'Inactive slot failed to start; active slot left untouched',
      failedCheck: 'inactive_slot_start',
      keyOutput: error instanceof Error ? error.message : String(error),
      retryable: true,
      nextAction: 'inspect inactive slot logs under runtime-slots/<slot>/logs',
      details: { activeSlot: active, activeReadyBefore },
    });
  }

  if (!started.verification.ok) {
    return compositeFailed({
      phase: started.verification.phase,
      summary: 'Inactive slot verification failed; active slot left untouched',
      failedCheck: 'inactive_slot_verify',
      keyOutput: started.verification.failures.join('; '),
      retryable: true,
      nextAction: 'fix green source and retry controller rollout',
      details: {
        activeSlot: active,
        candidateSlot: started.slot,
        failures: started.verification.failures,
        activeReadyBefore,
      },
    });
  }

  // Generation/source consistency gate before cutover.
  if (!started.verification.generation) {
    return compositeFailed({
      phase: 'pre-cutover',
      summary: 'Candidate generation missing; refusing cutover',
      failedCheck: 'generation',
      keyOutput: 'candidate runtime generation is missing',
    });
  }

  const previous = authority.activeSlot;
  const nextAuthority = markCutoverAuthority(rootHome, started.slot, started.verification.generation);
  writeSlotIdentity(rootHome, {
    ...started.identity,
    role: 'active',
  });
  const previousIdentity = readSlotIdentity(rootHome, previous);
  if (previousIdentity) {
    writeSlotIdentity(rootHome, { ...previousIdentity, role: 'standby' });
  }

  // Re-verify ChatGPT-facing surface via active slot home after authority flip.
  const post = await verifySlotHealth(repoRoot, started.slotHome, {
    requireGeneration: started.verification.generation,
    skipDurableJob: opts.skipDurableJob,
  });
  if (!post.ok) {
    // Automatic rollback
    markRollbackAuthority(rootHome, activeBefore.runtimeGeneration);
    try {
      await stopControllerService({
        repo: repoRoot,
        controllerHome: started.slotHome,
        stopTimeoutMs: opts.stopTimeoutMs,
        protectCallerAncestry: false,
        requireFullStop: true,
        slotLocalLifecycle: true,
      });
    } catch {
      // keep rollback primary
    }
    return compositeFailed({
      phase: 'cutover-verify',
      summary: 'Cutover verification failed; rolled back to previous active slot',
      failedCheck: 'cutover_verify',
      keyOutput: post.failures.join('; '),
      retryable: true,
      nextAction: 'inspect evidence and retry rollout',
      details: {
        rolledBackTo: previous,
        failedSlot: started.slot,
        failures: post.failures,
      },
    });
  }

  return compositeSucceeded({
    phase: 'cutover',
    summary: `Rollout complete: active slot is now ${started.slot}`,
    keyOutput: [
      `active=${started.slot}`,
      `previous=${previous}`,
      `generation=${started.verification.generation}`,
      `source=${started.verification.sourceCommit ?? 'unknown'}`,
      `mcpPort=${started.identity.mcpPort}`,
      `localPort=${started.identity.localControllerPort}`,
      `rollbackUntil=${nextAuthority.rollbackUntil ?? 'none'}`,
    ].join('\n'),
    nextAction: 'use controller status; rollback available within rollback window',
    details: {
      authority: nextAuthority,
      candidate: started.identity,
      verification: started.verification,
      postCutover: post,
    },
  });
}

export async function controllerRollback(opts: BlueGreenRolloutOptions = {}): Promise<CompositeToolResult> {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const rootHome = resolveRepoPreferredControllerHome(repoRoot, opts.controllerHome);
  if (isStableSupervisorInstalled(rootHome)) {
    return stableSupervisorRollback(repoRoot, rootHome, opts);
  }
  const authority = readActiveSlotAuthority(rootHome);
  if (!authority.previousSlot) {
    return compositeFailed({
      phase: 'rollback',
      summary: 'No previous slot recorded for rollback',
      failedCheck: 'rollback_window',
      retryable: false,
      nextAction: 'start a successful rollout before rollback',
    });
  }
  const failedSlot = authority.activeSlot;
  const restoreSlot = authority.previousSlot;
  const restoreHome = ensureSlotHome(rootHome, restoreSlot);
  const failedHome = ensureSlotHome(rootHome, failedSlot);

  // Ensure restore slot is healthy BEFORE stopping the failed slot, so the
  // control plane never has zero healthy owners during rollback.
  let restoreStatus = await controllerServiceStatus({ repo: repoRoot, controllerHome: restoreHome, slotLocalLifecycle: true });
  if (!restoreStatus.ready) {
    try {
      await startControllerService({
        repo: repoRoot,
        controllerHome: restoreHome,
        startTimeoutMs: opts.startTimeoutMs,
        logFile: join(restoreHome, 'logs', 'controller.log'),
        slotLocalLifecycle: true,
      });
      restoreStatus = await controllerServiceStatus({ repo: repoRoot, controllerHome: restoreHome, slotLocalLifecycle: true });
    } catch (error) {
      return compositeFailed({
        phase: 'rollback-start',
        summary: 'Failed to restore previous healthy slot',
        failedCheck: 'restore_start',
        keyOutput: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const preVerify = await verifySlotHealth(repoRoot, restoreHome, {
    skipDurableJob: opts.skipDurableJob,
  });
  if (!preVerify.ok) {
    return compositeFailed({
      phase: 'rollback-preverify',
      summary: 'Previous slot is not healthy enough to become active',
      failedCheck: 'restore_preverify',
      keyOutput: preVerify.failures.join('; '),
      details: { failures: preVerify.failures },
    });
  }

  const next = markRollbackAuthority(rootHome, restoreStatus.runtimeGeneration);
  const restoreIdentity = readSlotIdentity(rootHome, restoreSlot);
  if (restoreIdentity) writeSlotIdentity(rootHome, { ...restoreIdentity, role: 'active' });
  const failedIdentity = readSlotIdentity(rootHome, failedSlot);
  if (failedIdentity) writeSlotIdentity(rootHome, { ...failedIdentity, role: 'failed' });

  try {
    await stopControllerService({
      repo: repoRoot,
      controllerHome: failedHome,
      stopTimeoutMs: opts.stopTimeoutMs,
      protectCallerAncestry: false,
      requireFullStop: true,
      slotLocalLifecycle: true,
    });
  } catch (error) {
    // Keep evidence; still report partial success if restore is healthy.
    mkdirSync(join(failedHome, 'logs'), { recursive: true });
    writeFileSync(
      join(failedHome, 'logs', 'rollback-stop-error.txt'),
      error instanceof Error ? error.stack ?? error.message : String(error),
      'utf8',
    );
  }

  // Re-verify after failed-slot stop; retry briefly for port/health settle.
  let verify = await verifySlotHealth(repoRoot, restoreHome, { skipDurableJob: opts.skipDurableJob });
  if (!verify.ok) {
    for (let attempt = 0; attempt < 10 && !verify.ok; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      verify = await verifySlotHealth(repoRoot, restoreHome, { skipDurableJob: opts.skipDurableJob });
    }
  }
  if (!verify.ok) {
    return compositeFailed({
      phase: 'rollback-verify',
      summary: 'Rollback authority restored but health verification failed',
      failedCheck: 'rollback_verify',
      keyOutput: verify.failures.join('; '),
      details: { authority: next, failures: verify.failures },
    });
  }

  return compositeSucceeded({
    phase: 'rollback',
    summary: `Rollback complete: active slot is ${restoreSlot}`,
    keyOutput: [
      `active=${restoreSlot}`,
      `stopped=${failedSlot}`,
      `generation=${restoreStatus.runtimeGeneration ?? 'unknown'}`,
    ].join('\n'),
    nextAction: 'inspect failed slot logs under runtime-slots for evidence',
    details: { authority: next, verification: verify },
  });
}

export function assertNotRealControllerHome(controllerHome: string, realHomeHints: string[] = []): void {
  const normalized = controllerHome.replace(/\\/g, '/');
  const hints = [
    ...realHomeHints,
    `${process.env.HOME ?? ''}/.repo-harness/controller`,
    '/_ops/controller-home',
  ].filter(Boolean);
  for (const hint of hints) {
    if (hint && normalized.includes(hint.replace(/\\/g, '/'))) {
      // allow temp paths that happen to include the string only as substring of mkdtemp
      if (normalized.includes('/repo-harness-') || normalized.includes('/tmp') || normalized.includes('/var/folders')) {
        continue;
      }
      throw new Error(`TEST_GUARD: refusing to use real controller home ${controllerHome}`);
    }
  }
  if (!existsSync(controllerHome) && !normalized.includes('repo-harness') && !normalized.includes('tmp')) {
    // still ok — callers create homes
  }
}
