import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
  compositeFailed,
  compositeSucceeded,
  type CompositeToolResult,
} from './composite-result';
import { readRuntimeGeneration } from '../../runtime/control-plane/runtime-generation';
import { createExecutionJob, getExecutionJob } from '../../runtime/execution/jobs/store';
import { CONTROLLER_SCOPE_REPO_ID } from '../repositories/controller-home';
import { randomUUID } from 'crypto';

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
  const status = await controllerServiceStatus({ repo: repoRoot, controllerHome: slotHome });
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

  const activeBefore = await controllerServiceStatus({ repo: repoRoot, controllerHome: activeHome });
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
  let restoreStatus = await controllerServiceStatus({ repo: repoRoot, controllerHome: restoreHome });
  if (!restoreStatus.ready) {
    try {
      await startControllerService({
        repo: repoRoot,
        controllerHome: restoreHome,
        startTimeoutMs: opts.startTimeoutMs,
        logFile: join(restoreHome, 'logs', 'controller.log'),
      });
      restoreStatus = await controllerServiceStatus({ repo: repoRoot, controllerHome: restoreHome });
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
