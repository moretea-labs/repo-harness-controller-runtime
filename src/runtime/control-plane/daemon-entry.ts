#!/usr/bin/env bun
import { existsSync, writeFileSync, rmSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { writeJsonAtomic } from '../shared/json-files';
import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';
import { controllerDaemonOwnsPidFile } from './daemon-ownership';
import { GlobalScheduler } from './global-scheduler/scheduler';
import { bindRuntimeWriterClaim } from '../../cli/controller/stable-state/runtime-writer-context';
import {
  collectRuntimeSourceIdentity,
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
  readRuntimeGeneration,
  resolveControllerRuntimeSourceRoot,
  rotateRuntimeGeneration,
  type RuntimeGenerationRecord,
} from './runtime-generation';
import { reconcileControllerStartup, type ControllerStartupRecoveryResult } from './startup-recovery';
import { applyRuntimeCleanup, type RuntimeCleanupApplyResult } from '../maintenance/cleanup';
import { recoverActivationTransaction, readActivationAuthority } from '../bootstrap/activation-transaction';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function optionOrEnv(name: string, envName: string): string | undefined {
  return option(name) ?? process.env[envName];
}

function childOwnershipMetadata(): { instanceId?: string; ownerEpoch?: number; slot?: 'blue' | 'green' } {
  const ownerEpochValue = optionOrEnv('--owner-epoch', 'REPO_HARNESS_SUPERVISOR_EPOCH');
  const ownerEpoch = ownerEpochValue && /^\d+$/.test(ownerEpochValue) ? Number(ownerEpochValue) : undefined;
  const slotValue = option('--slot') ?? process.env.REPO_HARNESS_RUNTIME_SLOT;
  const slot = slotValue === 'blue' || slotValue === 'green' ? slotValue : undefined;
  const instanceId = option('--instance-id') ?? process.env.REPO_HARNESS_DAEMON_INSTANCE_ID;
  return { ...(instanceId ? { instanceId } : {}), ...(ownerEpoch !== undefined ? { ownerEpoch } : {}), ...(slot ? { slot } : {}) };
}

const DEFAULT_AUTOMATIC_CLEANUP_INITIAL_DELAY_MS = 60_000;
const DEFAULT_AUTOMATIC_CLEANUP_INTERVAL_MS = 60 * 60_000;
const DEFAULT_AUTOMATIC_CLEANUP_MIN_AGE_MINUTES = 24 * 60;
const DEFAULT_AUTOMATIC_CLEANUP_MAX_REMOVALS = 50;

function numericEnv(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.trunc(parsed)) : fallback;
}

export interface AutomaticRuntimeCleanupOptions {
  initialDelayMs?: number;
  intervalMs?: number;
  minAgeMinutes?: number;
  maxRemovals?: number;
  cleanup?: (repoRoot: string, options: Parameters<typeof applyRuntimeCleanup>[1]) => RuntimeCleanupApplyResult;
  onError?: (error: unknown) => void;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolveDelay();
    }
  });
}

export function runAutomaticRuntimeCleanupCycle(
  repoRoot: string,
  options: AutomaticRuntimeCleanupOptions = {},
): RuntimeCleanupApplyResult | undefined {
  try {
    const maxRemovals = options.maxRemovals
      ?? numericEnv('REPO_HARNESS_AUTOMATIC_CLEANUP_MAX_REMOVALS', DEFAULT_AUTOMATIC_CLEANUP_MAX_REMOVALS, 1);
    return (options.cleanup ?? applyRuntimeCleanup)(repoRoot, {
      minAgeMinutes: options.minAgeMinutes
        ?? numericEnv('REPO_HARNESS_AUTOMATIC_CLEANUP_MIN_AGE_MINUTES', DEFAULT_AUTOMATIC_CLEANUP_MIN_AGE_MINUTES, 60),
      includeTempDirs: true,
      includeTerminalLocalJobs: false,
      includeLegacyRuns: false,
      includeHistoricalAttention: false,
      maxCandidates: Math.max(1, Math.min(maxRemovals * 3, 200)),
      maxRemovals,
      confirmCleanup: true,
    });
  } catch (error) {
    (options.onError ?? ((failure) => console.error('[repo-harness cleanup] automatic cleanup failed:', failure)))(error);
    return undefined;
  }
}

export async function runAutomaticRuntimeCleanupLoop(
  repoRoot: string,
  signal: AbortSignal,
  options: AutomaticRuntimeCleanupOptions = {},
): Promise<void> {
  const initialDelayMs = options.initialDelayMs
    ?? numericEnv('REPO_HARNESS_AUTOMATIC_CLEANUP_INITIAL_DELAY_MS', DEFAULT_AUTOMATIC_CLEANUP_INITIAL_DELAY_MS, 0);
  const intervalMs = options.intervalMs
    ?? numericEnv('REPO_HARNESS_AUTOMATIC_CLEANUP_INTERVAL_MS', DEFAULT_AUTOMATIC_CLEANUP_INTERVAL_MS, 60_000);
  await abortableDelay(initialDelayMs, signal);
  while (!signal.aborted) {
    runAutomaticRuntimeCleanupCycle(repoRoot, options);
    await abortableDelay(intervalMs, signal);
  }
}

export function controllerDaemonMaxLifetimeMs(controllerHome: string, configuredValue = process.env.REPO_HARNESS_DAEMON_MAX_LIFETIME_MS): number | undefined {
  const configuredMaxLifetimeMs = Number(configuredValue);
  const resolvedHome = resolve(controllerHome);
  const temporaryHarnessHome = resolvedHome.startsWith(`${resolve(tmpdir())}${sep}`)
    && /(?:^|[\\/])repo-harness-(?:controller|supervisor|runtime)/.test(resolvedHome);
  if (Number.isFinite(configuredMaxLifetimeMs) && configuredMaxLifetimeMs >= 1_000) return Math.trunc(configuredMaxLifetimeMs);
  return temporaryHarnessHome ? 5 * 60_000 : undefined;
}

export function startControllerDaemon(controllerHome: string): void {
  // Capture writer identity once for this daemon process (slot path → stable root authority).
  // Daemon is the active-runtime owner and may adopt current authority at startup.
  // Workers must NOT re-adopt; they inherit the daemon's captured claim via spawn args.
  try {
    const ownershipEarly = childOwnershipMetadata();
    const inheritedEpoch = process.env.REPO_HARNESS_WRITER_EPOCH?.trim() || undefined;
    const inheritedToken = process.env.REPO_HARNESS_WRITER_FENCING_TOKEN?.trim() || undefined;
    const inheritedSlot = (process.env.REPO_HARNESS_WRITER_SLOT?.trim() as 'blue' | 'green' | undefined)
      ?? ownershipEarly.slot;
    const inheritedGeneration = process.env.REPO_HARNESS_WRITER_GENERATION?.trim() || undefined;
    bindRuntimeWriterClaim({
      controllerHome,
      slot: inheritedSlot,
      generation: inheritedGeneration,
      epoch: inheritedEpoch,
      fencingToken: inheritedToken,
      allowLegacyMissing: true,
      adoptCurrentAuthority: !(inheritedEpoch && inheritedToken),
    });
  } catch (error) {
    // Fail closed: authority exists (or bind rules failed) but we cannot bind a
    // complete claim → refuse readiness rather than start as an unbound writer.
    const message = error instanceof Error ? error.message : String(error);
    console.error('[repo-harness daemon] writer claim bind failed:', message);
    process.exit(78);
  }
  const statePath = join(controllerHome, 'daemon', 'state.json');
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  const abort = new AbortController();
  const startedAt = new Date().toISOString();
  const ownership = childOwnershipMetadata();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => abort.abort());
  const effectiveMaxLifetimeMs = controllerDaemonMaxLifetimeMs(controllerHome);
  const maxLifetimeTimer = effectiveMaxLifetimeMs
    ? setTimeout(() => abort.abort(), effectiveMaxLifetimeMs)
    : undefined;
  maxLifetimeTimer?.unref?.();

  const runtime = publishReadyAfterStartupRecovery(controllerHome, startedAt);
  void runAutomaticRuntimeCleanupLoop(runtime.generationRecord.source.repoRoot, abort.signal);
  const bundledWorkerPath = process.argv[1]
    ? join(dirname(resolve(process.argv[1])), 'worker.js')
    : undefined;

  const scheduler = new GlobalScheduler(controllerHome, {}, {
    controllerPid: process.pid,
    controllerStartedAt: startedAt,
    runtimeSourceRoot: runtime.generationRecord.source.repoRoot,
    ...(bundledWorkerPath && existsSync(bundledWorkerPath) ? { workerEntrypoint: bundledWorkerPath } : {}),
    ...(ownership.ownerEpoch !== undefined ? { ownerEpoch: String(ownership.ownerEpoch) } : {}),
  });
  let schedulerFailure: string | undefined;
  scheduler.run(abort.signal)
    .catch((error) => {
      schedulerFailure = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    })
    .finally(() => {
      abort.abort();
      if (maxLifetimeTimer) clearTimeout(maxLifetimeTimer);
      if (!controllerDaemonOwnsPidFile(pidPath, process.pid)) {
        setImmediate(() => process.exit(process.exitCode ?? 0));
        return;
      }
      rmSync(pidPath, { force: true });
      const stoppedAt = new Date().toISOString();
      writeJsonAtomic(statePath, {
        schemaVersion: 1,
        status: schedulerFailure ? 'failed' : 'stopped',
        pid: process.pid,
        ...(schedulerFailure ? { error: schedulerFailure, updatedAt: stoppedAt } : { stoppedAt }),
        degraded: schedulerFailure ? true : runtime.degraded,
        recovery: runtime,
        generation: runtime.generationRecord.generation,
        source: runtime.generationRecord.source,
        ...ownership,
      });
      // The scheduler loop is the daemon lifecycle. Once it terminates, do not
      // leave a live process shell that can be mistaken for an active daemon or
      // retain stale handles after a Supervisor replacement.
      setImmediate(() => process.exit(process.exitCode ?? 0));
    });
}

export function publishReadyAfterStartupRecovery(
  controllerHome: string,
  startedAt: string,
  recover: (home: string) => ControllerStartupRecoveryResult = reconcileControllerStartup,
): ControllerStartupRecoveryResult & {
  generationRecord: RuntimeGenerationRecord;
} {
  const statePath = join(controllerHome, 'daemon', 'state.json');
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  const ownership = childOwnershipMetadata();
  // Runtime Source is controller-scoped and package-derived. Never capture ambient
  // execution-repository cwd as the runtime identity (multi-repo false drift).
  const resolvedSource = resolveControllerRuntimeSourceRoot({
    explicitRoot: optionOrEnv('--runtime-source-root', CONTROLLER_RUNTIME_SOURCE_ROOT_ENV),
  });
  if (!resolvedSource.root) {
    throw new Error(
      `Controller daemon cannot resolve runtime source root: ${resolvedSource.detail ?? resolvedSource.reason}. `
      + `Set ${CONTROLLER_RUNTIME_SOURCE_ROOT_ENV} to the controller package/source checkout.`,
    );
  }
  // Recover / materialize activation authority before generation decisions.
  try {
    const recovery = recoverActivationTransaction(controllerHome);
    if (recovery.status === 'incomplete' || recovery.status === 'prepared') {
      throw new Error(
        `ACTIVATION_INCOMPLETE: ${recovery.error ?? recovery.status}; refusing ready until authority is committed`,
      );
    }
    // Generation must stay coherent with activation authority. Ordinary restart
    // must NOT mint a new generation while continuing to use the old writer epoch.
    const authority = readActivationAuthority(controllerHome);
    const inheritedGeneration = process.env.REPO_HARNESS_WRITER_GENERATION?.trim()
      || authority?.generation;
    if (inheritedGeneration) {
      const existing = readRuntimeGeneration(controllerHome);
      const source = collectRuntimeSourceIdentity(resolvedSource.root);
      const path = join(ensureControllerHome(controllerHome), 'system', 'runtime-generation.json');
      if (existing && existing.generation === inheritedGeneration) {
        // Reuse the generation but refresh the source identity when the
        // release commit changed (e.g. after a supervisor-managed restart
        // into a new immutable release built from a newer main commit).
        if (source && existing.source?.commit !== source.commit) {
          writeJsonAtomic(path, {
            ...existing,
            source,
            revision: Math.max(0, existing.revision ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          });
        }
      } else {
        // Persist the authority generation without inventing a new one.
        writeJsonAtomic(path, {
          schemaVersion: 1,
          generation: inheritedGeneration,
          revision: Math.max(0, existing?.revision ?? 0) + 1,
          controllerHome: ensureControllerHome(controllerHome),
          source,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('ACTIVATION_INCOMPLETE:')) throw error;
    // Legacy homes without activation still rotate.
  }
  let generation = readRuntimeGeneration(controllerHome);
  if (!generation) {
    generation = rotateRuntimeGeneration(
      controllerHome,
      collectRuntimeSourceIdentity(resolvedSource.root),
    );
  }
  // Fail closed when authority generation and daemon generation diverge.
  try {
    const authority = readActivationAuthority(controllerHome);
    if (authority?.generation && generation.generation !== authority.generation) {
      throw new Error(
        `GENERATION_AUTHORITY_MISMATCH: daemon generation ${generation.generation} != authority generation ${authority.generation}; refusing ready`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('GENERATION_AUTHORITY_MISMATCH:')) throw error;
  }
  // The controller is observably starting while recovery is synchronous. A
  // gateway must never see ready before durable truth has been reconciled.
  writeJsonAtomic(statePath, {
    schemaVersion: 1,
    status: 'starting',
    pid: process.pid,
    startedAt,
    controllerHome,
    gatewaySeparated: true,
    workerIsolation: true,
    generation: generation.generation,
    source: generation.source,
    ...ownership,
  });
  writeFileSync(pidPath, `${process.pid}\n`, 'utf8');

  let recovery: ControllerStartupRecoveryResult;
  try {
    recovery = recover(controllerHome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recovery = {
      completedAt: new Date().toISOString(),
      repositories: [],
      errors: [{ repoId: '__controller__', phase: 'execution-indexes', code: 'RECOVERY_FAILED', message }],
      degraded: true,
    };
  }
  writeJsonAtomic(statePath, {
    schemaVersion: 1,
    status: 'ready',
    pid: process.pid,
    startedAt,
    controllerHome,
    gatewaySeparated: true,
    workerIsolation: true,
    degraded: recovery.degraded,
    recovery,
    generation: generation.generation,
    source: generation.source,
    ...ownership,
  });
  return { ...recovery, generationRecord: generation };
}

if (import.meta.main || /[\\/]daemon-entry\.ts$/.test(process.argv[1] ?? '')) {
  const controllerHome = ensureControllerHome(option('--controller-home'));
  bootstrapManagedRuntimeEnv({ controllerHome });
  startControllerDaemon(controllerHome);
}
