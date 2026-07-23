import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { publishSupervisorRelease, type SupervisorInstallResult } from './installer';
import { readCurrentRelease, readCurrentSupervisorRelease, supervisorRoot } from './paths';
import { writeJsonAtomic } from '../shared/json-files';

export interface SupervisorActivationSchedule {
  activationId: string;
  pid: number;
  statePath: string;
  logPath: string;
  expectedReleaseRevision?: string;
  expectedReleasePath?: string;
}

export interface SupervisorReleaseActivationResult {
  publication: SupervisorInstallResult;
  activation: SupervisorActivationSchedule;
}

export interface SupervisorReleaseActivationDependencies {
  publish?: typeof publishSupervisorRelease;
  schedule?: typeof scheduleServiceActivation;
}

export function serviceActivationStatePath(home: string): string {
  return join(supervisorRoot(home), 'activation.json');
}

function readActivationState(home: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(serviceActivationStatePath(home), 'utf8')) as Record<string, unknown>;
    return parsed?.schemaVersion === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeActivationState(home: string, value: Record<string, unknown>): void {
  writeJsonAtomic(serviceActivationStatePath(home), {
    ...(readActivationState(home) ?? {}),
    schemaVersion: 1,
    ...value,
    updatedAt: new Date().toISOString(),
  });
}

export function scheduleServiceActivation(
  repo: string,
  home: string,
  handoffDelayMs = 750,
): SupervisorActivationSchedule {
  const activationId = `sup-activate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const expectedRelease = readCurrentSupervisorRelease(home);
  const currentRelease = readCurrentRelease(home);
  const installedCli = currentRelease ? join(currentRelease, 'repo-harness.js') : undefined;
  const cliEntry = installedCli && existsSync(installedCli)
    ? installedCli
    : process.argv[1] ? resolve(process.argv[1]) : undefined;
  if (!cliEntry) throw new Error('SUPERVISOR_ACTIVATION_ENTRY_UNAVAILABLE');
  const logPath = join(supervisorRoot(home), 'logs', 'activation.log');
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [
      cliEntry,
      'supervisor',
      '__activate',
      '--repo', repo,
      '--controller-home', home,
      '--activation-id', activationId,
      '--handoff-delay-ms', String(Math.max(750, Math.min(Math.trunc(handoffDelayMs), 30_000))),
    ], {
      cwd: repo,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, REPO_HARNESS_CONTROLLER_HOME: home },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error('SUPERVISOR_ACTIVATION_SPAWN_FAILED');
  writeActivationState(home, {
    activationId,
    phase: 'scheduled',
    pid: child.pid,
    repoRoot: repo,
    startedAt: new Date().toISOString(),
    ...(expectedRelease?.releaseRevision ? { expectedReleaseRevision: expectedRelease.releaseRevision } : {}),
    ...(expectedRelease?.releasePath ? { expectedReleasePath: expectedRelease.releasePath } : {}),
  });
  return {
    activationId,
    pid: child.pid,
    statePath: serviceActivationStatePath(home),
    logPath,
    ...(expectedRelease?.releaseRevision ? { expectedReleaseRevision: expectedRelease.releaseRevision } : {}),
    ...(expectedRelease?.releasePath ? { expectedReleasePath: expectedRelease.releasePath } : {}),
  };
}

export function publishAndScheduleSupervisorRelease(
  input: {
    controllerHome: string;
    repoRoot: string;
    releasePath: string;
    handoffDelayMs?: number;
  },
  dependencies: SupervisorReleaseActivationDependencies = {},
): SupervisorReleaseActivationResult {
  const publish = dependencies.publish ?? publishSupervisorRelease;
  const schedule = dependencies.schedule ?? scheduleServiceActivation;
  const previous = readCurrentSupervisorRelease(input.controllerHome);
  const publication = publish({
    controllerHome: input.controllerHome,
    repoRoot: input.repoRoot,
    releasePath: input.releasePath,
  });
  try {
    const activation = schedule(input.repoRoot, input.controllerHome, input.handoffDelayMs ?? 2_000);
    return { publication, activation };
  } catch (error) {
    let restoreError: unknown;
    if (previous?.releasePath && previous.releasePath !== publication.releasePath) {
      try {
        publish({
          controllerHome: input.controllerHome,
          repoRoot: input.repoRoot,
          releasePath: previous.releasePath,
        });
      } catch (caught) {
        restoreError = caught;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (restoreError) {
      const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(`SUPERVISOR_ACTIVATION_SCHEDULE_FAILED: ${message}; release restore failed: ${restoreMessage}`);
    }
    throw new Error(`SUPERVISOR_ACTIVATION_SCHEDULE_FAILED: ${message}`);
  }
}
