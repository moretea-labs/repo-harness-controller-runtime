#!/usr/bin/env bun
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { writeJsonAtomic } from '../shared/json-files';
import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';
import { controllerDaemonOwnsPidFile } from './daemon-ownership';
import { GlobalScheduler } from './global-scheduler/scheduler';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const controllerHome = ensureControllerHome(option('--controller-home'));
bootstrapManagedRuntimeEnv({ controllerHome });
const statePath = join(controllerHome, 'daemon', 'state.json');
const pidPath = join(controllerHome, 'daemon', 'controller.pid');
const abort = new AbortController();
const startedAt = new Date().toISOString();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => abort.abort());
writeJsonAtomic(statePath, {
  schemaVersion: 1,
  status: 'ready',
  pid: process.pid,
  startedAt,
  controllerHome,
  gatewaySeparated: true,
  workerIsolation: true,
});
writeFileSync(pidPath, `${process.pid}\n`, 'utf8');
const scheduler = new GlobalScheduler(controllerHome, {}, {
  controllerPid: process.pid,
  controllerStartedAt: startedAt,
});
scheduler.run(abort.signal)
  .catch((error) => {
    if (controllerDaemonOwnsPidFile(pidPath, process.pid)) {
      writeJsonAtomic(statePath, { schemaVersion: 1, status: 'failed', pid: process.pid, error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
    }
    process.exitCode = 1;
  })
  .finally(() => {
    if (!controllerDaemonOwnsPidFile(pidPath, process.pid)) return;
    rmSync(pidPath, { force: true });
    writeJsonAtomic(statePath, { schemaVersion: 1, status: 'stopped', pid: process.pid, stoppedAt: new Date().toISOString() });
  });
