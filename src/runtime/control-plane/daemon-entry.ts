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

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function optionOrEnv(name: string, envName: string): string | undefined {
  return option(name) ?? process.env[envName];
}

export function startControllerDaemon(controllerHome: string): void {
  const statePath = join(controllerHome, 'daemon', 'state.json');
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  const abort = new AbortController();
  const startedAt = new Date().toISOString();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => abort.abort());

  const runtime = publishReadyAfterStartupRecovery(controllerHome, startedAt);

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
