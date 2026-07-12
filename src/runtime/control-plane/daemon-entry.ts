#!/usr/bin/env bun
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { writeJsonAtomic } from '../shared/json-files';
import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';
import { controllerDaemonOwnsPidFile } from './daemon-ownership';
import { GlobalScheduler } from './global-scheduler/scheduler';
import { reconcileControllerStartup, type ControllerStartupRecoveryResult } from './startup-recovery';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function startControllerDaemon(controllerHome: string): void {
  const statePath = join(controllerHome, 'daemon', 'state.json');
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  const abort = new AbortController();
  const startedAt = new Date().toISOString();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => abort.abort());

  const recovery = publishReadyAfterStartupRecovery(controllerHome, startedAt);

  const scheduler = new GlobalScheduler(controllerHome, {}, {
    controllerPid: process.pid,
    controllerStartedAt: startedAt,
  });
  scheduler.run(abort.signal)
    .catch((error) => {
      if (controllerDaemonOwnsPidFile(pidPath, process.pid)) {
        writeJsonAtomic(statePath, { schemaVersion: 1, status: 'failed', pid: process.pid, error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString(), degraded: true, recovery });
      }
      process.exitCode = 1;
    })
    .finally(() => {
      if (!controllerDaemonOwnsPidFile(pidPath, process.pid)) return;
      rmSync(pidPath, { force: true });
      writeJsonAtomic(statePath, { schemaVersion: 1, status: 'stopped', pid: process.pid, stoppedAt: new Date().toISOString(), degraded: recovery.degraded, recovery });
    });
}

export function publishReadyAfterStartupRecovery(
  controllerHome: string,
  startedAt: string,
  recover: (home: string) => ControllerStartupRecoveryResult = reconcileControllerStartup,
): ControllerStartupRecoveryResult {
  const statePath = join(controllerHome, 'daemon', 'state.json');
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
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
  });
  return recovery;
}

if (import.meta.main || /[\\/]daemon-entry\.ts$/.test(process.argv[1] ?? '')) {
  const controllerHome = ensureControllerHome(option('--controller-home'));
  bootstrapManagedRuntimeEnv({ controllerHome });
  startControllerDaemon(controllerHome);
}
