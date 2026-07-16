import { chmodSync, existsSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { sanitizeFileComponent } from '../shared/json-files';

export function supervisorRoot(controllerHome: string): string {
  return join(resolve(controllerHome), 'supervisor');
}

export function supervisorReleasesRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'releases');
}

export function supervisorStatePath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'state.json');
}

export function supervisorLockPath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'supervisor.lock');
}

export function supervisorControlSocketPath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'control.sock');
}

export function supervisorOperationsRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'operations');
}

export function supervisorOperationPath(controllerHome: string, operationId: string): string {
  return join(supervisorOperationsRoot(controllerHome), `${sanitizeFileComponent(operationId)}.json`);
}

export function supervisorOperationLockPath(controllerHome: string): string {
  return join(supervisorOperationsRoot(controllerHome), '.schedule.lock');
}

export function supervisorIncidentsRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'incidents');
}

export function supervisorLogsRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'logs');
}

export function supervisorLogPath(controllerHome: string): string {
  return join(supervisorLogsRoot(controllerHome), 'supervisor.log');
}

export function supervisorRescueAuthPath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'rescue-auth.json');
}

export function supervisorCurrentReleasePath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'current');
}

export function supervisorPreviousReleasePath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'previous');
}

export function ensureStableSupervisorLayout(controllerHome: string): string {
  const home = ensureControllerHome(controllerHome);
  const root = supervisorRoot(home);
  for (const directory of [root, supervisorReleasesRoot(home), supervisorOperationsRoot(home), supervisorIncidentsRoot(home), supervisorLogsRoot(home)]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  }
  return root;
}

export function readCurrentRelease(controllerHome: string): string | undefined {
  const current = supervisorCurrentReleasePath(controllerHome);
  try {
    if (!existsSync(current)) return undefined;
    return resolve(dirname(current), readlinkSync(current));
  } catch {
    return undefined;
  }
}

export function isStableSupervisorInstalled(controllerHome: string): boolean {
  const release = readCurrentRelease(controllerHome);
  return Boolean(release && existsSync(join(release, 'supervisor.js')) && existsSync(join(release, 'repo-harness.js')) && existsSync(join(release, 'daemon.js')));
}

export function publishCurrentRelease(controllerHome: string, releasePath: string, previous?: string): void {
  ensureStableSupervisorLayout(controllerHome);
  const current = supervisorCurrentReleasePath(controllerHome);
  const previousPath = supervisorPreviousReleasePath(controllerHome);
  const temporaryCurrent = `${current}.${process.pid}.tmp`;
  const temporaryPrevious = `${previousPath}.${process.pid}.tmp`;
  if (previous && existsSync(previous)) {
    try { unlinkSync(temporaryPrevious); } catch { /* absent */ }
    symlinkSync(resolve(previous), temporaryPrevious, 'dir');
    renameSync(temporaryPrevious, previousPath);
  }
  try { unlinkSync(temporaryCurrent); } catch { /* absent */ }
  symlinkSync(resolve(releasePath), temporaryCurrent, 'dir');
  renameSync(temporaryCurrent, current);
}
