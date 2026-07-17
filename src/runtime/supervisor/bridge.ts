import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { resolve } from 'path';
import { createSupervisorOperation } from './operation-store';
import { defaultProcessIdentityProbe, processIdentityMatches } from './identity';
import { sendSupervisorCommand } from './control-server';
import { isStableSupervisorInstalled, readCurrentSupervisorRelease, supervisorLogPath } from './paths';
import { readSupervisorState } from './state-store';
import type { SupervisorOperation, SupervisorOperationKind, SupervisorState } from './types';
import { isProcessAlive, terminateProcessTree } from '../shared/process-tree';

export interface StableSupervisorLaunchOptions {
  repoRoot: string;
  controllerHome: string;
  logPath?: string;
  controlHost?: string;
  controlPort?: number;
}

export interface StableSupervisorLaunchResult {
  pid: number;
  releasePath: string;
}

export function readStableSupervisorState(controllerHome: string): SupervisorState | null {
  return readSupervisorState(controllerHome);
}

export function stableSupervisorIsAlive(controllerHome: string, state = readStableSupervisorState(controllerHome)): boolean {
  if (!state || !isStableSupervisorInstalled(controllerHome) || state.desiredState !== 'running') return false;
  if (!isProcessAlive(state.supervisor.pid)) return false;
  return processIdentityMatches(state.supervisor, state.supervisor.pid, defaultProcessIdentityProbe).matches;
}

export function launchStableSupervisor(options: StableSupervisorLaunchOptions): StableSupervisorLaunchResult {
  const release = readCurrentSupervisorRelease(options.controllerHome);
  if (!release) throw new Error('SUPERVISOR_RELEASE_NOT_INSTALLED');
  const releasePath = release.releasePath;
  const logPath = options.logPath ?? supervisorLogPath(options.controllerHome);
  const fd = openSync(logPath, 'a');
  try {
    const args = [
      release.supervisorExecutable,
      '--repo', resolve(options.repoRoot),
      '--controller-home', resolve(options.controllerHome),
      '--runtime-source-root', resolve(release.sourceRoot ?? options.repoRoot),
      ...(release.releaseRevision ? ['--release-revision', release.releaseRevision] : []),
      ...(options.controlHost ? ['--control-host', options.controlHost] : []),
      ...(options.controlPort !== undefined ? ['--control-port', String(options.controlPort)] : []),
    ];
    const child = spawn(process.execPath, args, {
      cwd: resolve(options.repoRoot),
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        REPO_HARNESS_CONTROLLER_HOME: resolve(options.controllerHome),
        REPO_HARNESS_STABLE_SUPERVISOR: '1',
      },
    });
    child.unref();
    if (!child.pid) throw new Error('SUPERVISOR_START_FAILED');
    return { pid: child.pid, releasePath };
  } finally {
    closeSync(fd);
  }
}

export function scheduleStableSupervisorOperation(input: {
  controllerHome: string;
  repoRoot: string;
  requestId: string;
  kind: SupervisorOperationKind;
  actor: string;
  reason?: string;
}): { operation: SupervisorOperation; deduplicated: boolean } | undefined {
  // A published release is not an execution owner. During first installation
  // the legacy stack must keep using the detached coordinator until an
  // identity-proven Supervisor is actually alive to consume durable operations.
  if (!stableSupervisorIsAlive(input.controllerHome)) return undefined;
  return createSupervisorOperation({
    controllerHome: input.controllerHome,
    repoRoot: input.repoRoot,
    requestId: input.requestId,
    kind: input.kind,
    requestedBy: input.actor,
    actor: input.actor,
    reason: input.reason,
  });
}

export async function submitStableSupervisorOperation(input: {
  controllerHome: string;
  requestId: string;
  kind: SupervisorOperationKind;
  actor: string;
  reason?: string;
}): Promise<{ operation?: SupervisorOperation; deduplicated?: boolean; error?: string }> {
  try {
    const response = await sendSupervisorCommand(input.controllerHome, {
      command: 'operation_submit',
      requestId: input.requestId,
      kind: input.kind,
      actor: input.actor,
      reason: input.reason,
    });
    if (!response.ok || !response.operation) return { error: response.error?.message ?? 'SUPERVISOR_OPERATION_REJECTED' };
    return { operation: response.operation, deduplicated: response.deduplicated };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function stopStableSupervisor(controllerHome: string): Promise<{ stopped: boolean; fallback: boolean }> {
  try {
    const response = await sendSupervisorCommand(controllerHome, { command: 'stop' });
    if (response.ok) return { stopped: true, fallback: false };
  } catch {
    // Fall through to identity-checked termination below.
  }
  const state = readStableSupervisorState(controllerHome);
  if (!state || !isProcessAlive(state.supervisor.pid)) return { stopped: true, fallback: true };
  if (!processIdentityMatches(state.supervisor, state.supervisor.pid, defaultProcessIdentityProbe).matches) {
    throw new Error(`SUPERVISOR_PROCESS_IDENTITY_MISMATCH: refusing to terminate pid=${state.supervisor.pid}`);
  }
  const result = await terminateProcessTree(state.supervisor.pid, { gracePeriodMs: 1_500, killAfterMs: 8_000, pollIntervalMs: 100 });
  return { stopped: result.exited, fallback: true };
}
