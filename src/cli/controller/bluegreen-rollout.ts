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
  isRollbackWindowOpen,
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
import { isStableSupervisorInstalled } from '../../runtime/supervisor/paths';
import { stageSupervisorRelease } from '../../runtime/supervisor/installer';
import { resolveControllerRuntimeSourceRoot } from '../../runtime/control-plane/runtime-generation';
import { sendSupervisorCommand } from '../../runtime/supervisor/control-server';
import { readStableSupervisorState } from '../../runtime/supervisor/bridge';
import { restartRequestNeedsDetachedCoordinator } from './restart-coordinator';

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
  /**
   * When true, the caller explicitly requests synchronous wait for the
   * Supervisor operation to reach a terminal phase. This is ONLY safe from
   * an external CLI process that is NOT a child of the managed runtime.
   * When omitted or false, the rollout submits the operation and returns
   * an accepted result immediately (out-of-band contract).
   */
  wait?: boolean;
}

const TERMINAL_SUPERVISOR_PHASES = new Set(['succeeded', 'failed', 'locked_out']);

function operationTimeoutMs(opts: BlueGreenRolloutOptions): number {
  return Math.max(180_000, (opts.startTimeoutMs ?? 60_000) * 3);
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

  // Determine whether synchronous wait is safe. If the caller is inside the
  // managed runtime ancestry (Gateway child, Durable Worker, MCP handler),
  // waiting would be suicidal because cutover kills the old slot processes.
  const wantsWait = opts.wait === true;
  const insideManagedAncestry = restartRequestNeedsDetachedCoordinator(repoRoot, rootHome);
  const safeToWait = wantsWait && !insideManagedAncestry;

  // Submit the operation to the root Stable Supervisor.
  const requestId = `controller-rollout-${Date.now()}-${randomUUID().slice(0, 10)}`;
  let submitted;
  try {
    submitted = await sendSupervisorCommand(rootHome, {
      command: 'operation_submit',
      requestId,
      kind: 'rollout',
      actor: 'controller-bluegreen-rollout',
      reason: opts.reason,
      candidateReleasePath: staged.releasePath,
    });
  } catch (error) {
    return compositeFailed({
      phase: 'supervisor-rollout',
      summary: 'Failed to submit rollout operation to the root Stable Supervisor',
      failedCheck: 'supervisor_operation_submit',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'inspect Supervisor control socket connectivity and retry',
      details: { stagedRelease: staged },
    });
  }
  if (!submitted.ok || !submitted.operation) {
    return compositeFailed({
      phase: 'supervisor-rollout',
      summary: 'Root Stable Supervisor rejected the rollout operation',
      failedCheck: 'supervisor_operation_rejected',
      keyOutput: submitted.error?.message ?? 'SUPERVISOR_OPERATION_REJECTED',
      nextAction: 'inspect Supervisor operation lock and retry',
      details: { stagedRelease: staged },
    });
  }
  if (staged.releasePath && submitted.operation.candidateReleasePath !== staged.releasePath) {
    return compositeFailed({
      phase: 'supervisor-rollout',
      summary: 'Supervisor did not accept the staged candidate release path',
      failedCheck: 'staged_rollout_capability_mismatch',
      keyOutput: 'SUPERVISOR_STAGED_ROLLOUT_CAPABILITY_MISMATCH',
      nextAction: 'verify the running Supervisor supports staged_rollout_release',
      details: { stagedRelease: staged, operation: submitted.operation },
    });
  }

  const operation = submitted.operation;

  // Out-of-band default: return accepted immediately. The Supervisor owns
  // the full rollout lifecycle including release publication.
  if (!safeToWait) {
    return {
      status: 'partial',
      phase: 'accepted',
      summary: wantsWait && insideManagedAncestry
        ? 'Rollout submitted; synchronous wait was refused because the caller is inside managed runtime ancestry'
        : 'Rollout operation submitted to the root Stable Supervisor',
      keyOutput: boundKeyOutput([
        `accepted=true`,
        `operationId=${operation.operationId}`,
        `requestId=${requestId}`,
        `reconnectContract=stable_domain_retry`,
        `stagedRelease=${staged.releaseRevision}`,
        `nextAction=poll supervisor operation or controller_ready`,
      ].join('\n')),
      evidenceRefs: [],
      retryable: false,
      nextAction: 'poll supervisor operation or controller_ready',
      details: {
        accepted: true,
        operationId: operation.operationId,
        requestId,
        reconnectContract: 'stable_domain_retry',
        stagedRelease: staged,
        ...(wantsWait && insideManagedAncestry ? { waitRefused: 'managed_runtime_ancestry' } : {}),
      },
    } as CompositeToolResult;
  }

  // Synchronous wait path (external CLI only).
  let finalOperation = operation;
  const deadline = Date.now() + operationTimeoutMs(opts);
  while (!TERMINAL_SUPERVISOR_PHASES.has(finalOperation.phase)) {
    if (Date.now() >= deadline) {
      return partialResult({
        phase: finalOperation.phase,
        summary: `Rollout operation ${finalOperation.operationId} has not reached a terminal phase within the timeout`,
        keyOutput: `operationId=${finalOperation.operationId}\nphase=${finalOperation.phase}`,
        nextAction: 'poll supervisor operation status; do not repeat rollout while this operation is active',
        details: { operation: finalOperation, stagedRelease: staged },
      });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const polled = await sendSupervisorCommand(rootHome, {
      command: 'operation_get',
      operationId: operation.operationId,
    });
    if (!polled.ok || !polled.operation) {
      return partialResult({
        phase: 'polling',
        summary: 'Lost contact with the Supervisor while polling rollout operation',
        keyOutput: polled.error?.message ?? 'SUPERVISOR_OPERATION_READ_FAILED',
        nextAction: 'reconnect and poll the operation; the Supervisor owns execution',
        details: { operation: finalOperation, stagedRelease: staged },
      });
    }
    finalOperation = polled.operation;
  }

  if (finalOperation.phase !== 'succeeded') {
    return compositeFailed({
      phase: finalOperation.phase,
      summary: 'Candidate verification or cutover failed',
      failedCheck: finalOperation.failureClass ?? 'supervisor_rollout',
      keyOutput: finalOperation.error ?? `operation ${finalOperation.operationId} ended in ${finalOperation.phase}`,
      nextAction: 'inspect candidate evidence and retry after fixing the release',
      details: { operation: finalOperation, stagedRelease: staged },
    });
  }

  const authority = readActiveSlotAuthority(rootHome);
  return compositeSucceeded({
    phase: 'cutover',
    summary: `Rollout complete: active slot is ${authority.activeSlot}`,
    keyOutput: [
      `operation=${finalOperation.operationId}`,
      `active=${authority.activeSlot}`,
      `generation=${authority.generation ?? 'unknown'}`,
      `release=${staged.releaseRevision}`,
    ].join('\n'),
    nextAction: 'use controller status to confirm the active immutable release and runtime generation',
    details: { authority, operation: finalOperation, stagedRelease: staged },
  });
}

async function stableSupervisorRollback(
  repoRoot: string,
  rootHome: string,
  opts: BlueGreenRolloutOptions,
): Promise<CompositeToolResult> {
  const supervisorState = readStableSupervisorState(rootHome);
  const rollbackAuthority = readActiveSlotAuthority(rootHome);
  const rollbackMode = supervisorState?.standby && isRollbackWindowOpen(rollbackAuthority) ? 'hot' : 'cold';

  // Determine whether synchronous wait is safe.
  const wantsWait = opts.wait === true;
  const insideManagedAncestry = restartRequestNeedsDetachedCoordinator(repoRoot, rootHome);
  const safeToWait = wantsWait && !insideManagedAncestry;

  // Submit the rollback operation to the root Stable Supervisor.
  const requestId = `controller-rollback-${Date.now()}-${randomUUID().slice(0, 10)}`;
  let submitted;
  try {
    submitted = await sendSupervisorCommand(rootHome, {
      command: 'operation_submit',
      requestId,
      kind: 'rollback',
      actor: 'controller-bluegreen-rollout',
      reason: opts.reason,
    });
  } catch (error) {
    return compositeFailed({
      phase: 'supervisor-rollback',
      summary: 'Failed to submit rollback operation to the root Stable Supervisor',
      failedCheck: 'supervisor_operation_submit',
      keyOutput: error instanceof Error ? error.message : String(error),
      nextAction: 'inspect Supervisor control socket connectivity and retry',
    });
  }
  if (!submitted.ok || !submitted.operation) {
    return compositeFailed({
      phase: 'supervisor-rollback',
      summary: 'Root Stable Supervisor rejected the rollback operation',
      failedCheck: 'supervisor_operation_rejected',
      keyOutput: submitted.error?.message ?? 'SUPERVISOR_OPERATION_REJECTED',
      nextAction: 'inspect Supervisor operation lock and retry',
    });
  }

  const operation = submitted.operation;

  // Out-of-band default: return accepted immediately.
  if (!safeToWait) {
    return {
      status: 'partial',
      phase: 'accepted',
      summary: wantsWait && insideManagedAncestry
        ? 'Rollback submitted; synchronous wait was refused because the caller is inside managed runtime ancestry'
        : `Rollback operation submitted to the root Stable Supervisor (${rollbackMode} mode)`,
      keyOutput: boundKeyOutput([
        `accepted=true`,
        `operationId=${operation.operationId}`,
        `requestId=${requestId}`,
        `reconnectContract=stable_domain_retry`,
        `rollbackMode=${rollbackMode}`,
        `nextAction=poll supervisor operation or controller_ready`,
      ].join('\n')),
      evidenceRefs: [],
      retryable: false,
      nextAction: 'poll supervisor operation or controller_ready',
      details: {
        accepted: true,
        operationId: operation.operationId,
        requestId,
        reconnectContract: 'stable_domain_retry',
        rollbackMode,
        ...(wantsWait && insideManagedAncestry ? { waitRefused: 'managed_runtime_ancestry' } : {}),
      },
    } as CompositeToolResult;
  }

  // Synchronous wait path (external CLI only).
  let finalOperation = operation;
  const deadline = Date.now() + operationTimeoutMs(opts);
  while (!TERMINAL_SUPERVISOR_PHASES.has(finalOperation.phase)) {
    if (Date.now() >= deadline) {
      return partialResult({
        phase: finalOperation.phase,
        summary: `Rollback operation ${finalOperation.operationId} has not reached a terminal phase within the timeout`,
        keyOutput: `operationId=${finalOperation.operationId}\nphase=${finalOperation.phase}`,
        nextAction: 'poll supervisor operation status; do not repeat rollback while this operation is active',
        details: { operation: finalOperation },
      });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const polled = await sendSupervisorCommand(rootHome, {
      command: 'operation_get',
      operationId: operation.operationId,
    });
    if (!polled.ok || !polled.operation) {
      return partialResult({
        phase: 'polling',
        summary: 'Lost contact with the Supervisor while polling rollback operation',
        keyOutput: polled.error?.message ?? 'SUPERVISOR_OPERATION_READ_FAILED',
        nextAction: 'reconnect and poll the operation; the Supervisor owns execution',
        details: { operation: finalOperation },
      });
    }
    finalOperation = polled.operation;
  }

  if (finalOperation.phase !== 'succeeded') {
    return compositeFailed({
      phase: finalOperation.phase,
      summary: 'Supervisor rollback failed',
      failedCheck: finalOperation.failureClass ?? 'supervisor_rollback',
      keyOutput: finalOperation.error ?? `operation ${finalOperation.operationId} ended in ${finalOperation.phase}`,
      nextAction: 'inspect rollback evidence before retrying',
      details: { operation: finalOperation },
    });
  }

  const authority = readActiveSlotAuthority(rootHome);
  return compositeSucceeded({
    phase: 'rollback',
    summary: `${rollbackMode === 'hot' ? 'Hot' : 'Cold'} rollback complete: active slot is ${authority.activeSlot}`,
    keyOutput: [
      `operation=${finalOperation.operationId}`,
      `active=${authority.activeSlot}`,
      `rollbackMode=${rollbackMode}`,
    ].join('\n'),
    nextAction: 'use controller status to confirm the restored immutable release and runtime generation',
    details: { authority, operation: finalOperation, rollbackMode },
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
