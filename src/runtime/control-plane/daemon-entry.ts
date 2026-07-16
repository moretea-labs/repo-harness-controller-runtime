#!/usr/bin/env bun
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { writeJsonAtomic } from '../shared/json-files';
import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';
import { controllerDaemonOwnsPidFile } from './daemon-ownership';
import { GlobalScheduler } from './global-scheduler/scheduler';
import {
  collectRuntimeSourceIdentity,
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
  resolveControllerRuntimeSourceRoot,
  rotateRuntimeGeneration,
  type RuntimeGenerationRecord,
} from './runtime-generation';
import { reconcileControllerStartup, type ControllerStartupRecoveryResult } from './startup-recovery';
import { applyRuntimeCleanup, type RuntimeCleanupApplyResult } from '../maintenance/cleanup';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function optionOrEnv(name: string, envName: string): string | undefined {
  return option(name) ?? process.env[envName];
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

export function startControllerDaemon(controllerHome: string): void {
  const statePath = join(controllerHome, 'daemon', 'state.json');
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  const abort = new AbortController();
  const startedAt = new Date().toISOString();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => abort.abort());
  const configuredMaxLifetimeMs = Number(process.env.REPO_HARNESS_DAEMON_MAX_LIFETIME_MS);
  const maxLifetimeTimer = Number.isFinite(configuredMaxLifetimeMs) && configuredMaxLifetimeMs >= 1_000
    ? setTimeout(() => abort.abort(), Math.trunc(configuredMaxLifetimeMs))
    : undefined;
  maxLifetimeTimer?.unref?.();

  const runtime = publishReadyAfterStartupRecovery(controllerHome, startedAt);
  void runAutomaticRuntimeCleanupLoop(runtime.generationRecord.source.repoRoot, abort.signal);

  const scheduler = new GlobalScheduler(controllerHome, {}, {
    controllerPid: process.pid,
    controllerStartedAt: startedAt,
  });
  scheduler.run(abort.signal)
    .catch((error) => {
      if (controllerDaemonOwnsPidFile(pidPath, process.pid)) {
        writeJsonAtomic(statePath, {
          schemaVersion: 1,
          status: 'failed',
          pid: process.pid,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
          degraded: true,
          recovery: runtime,
          generation: runtime.generationRecord.generation,
          source: runtime.generationRecord.source,
        });
      }
      process.exitCode = 1;
    })
    .finally(() => {
      abort.abort();
      if (maxLifetimeTimer) clearTimeout(maxLifetimeTimer);
      if (!controllerDaemonOwnsPidFile(pidPath, process.pid)) return;
      rmSync(pidPath, { force: true });
      writeJsonAtomic(statePath, {
        schemaVersion: 1,
        status: 'stopped',
        pid: process.pid,
        stoppedAt: new Date().toISOString(),
        degraded: runtime.degraded,
        recovery: runtime,
        generation: runtime.generationRecord.generation,
        source: runtime.generationRecord.source,
      });
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
  const generation = rotateRuntimeGeneration(
    controllerHome,
    collectRuntimeSourceIdentity(resolvedSource.root),
  );
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
  });
  return { ...recovery, generationRecord: generation };
}

if (import.meta.main || /[\\/]daemon-entry\.ts$/.test(process.argv[1] ?? '')) {
  const controllerHome = ensureControllerHome(option('--controller-home'));
  bootstrapManagedRuntimeEnv({ controllerHome });
  startControllerDaemon(controllerHome);
}
