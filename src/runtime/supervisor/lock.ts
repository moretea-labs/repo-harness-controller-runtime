import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { supervisorLockPath, ensureStableSupervisorLayout } from './paths';
import { captureProcessIdentity, defaultProcessIdentityProbe, executableFingerprint, newProcessInstanceId, processIdentityMatches, type ProcessIdentityProbe } from './identity';
import type { ProcessIdentity, SupervisorState } from './types';

export interface SupervisorLockMetadata extends ProcessIdentity {
  acquiredAt: string;
}

export interface SupervisorLockHandle {
  metadata: SupervisorLockMetadata;
  release(): void;
}

function readLock(path: string): SupervisorLockMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as SupervisorLockMetadata;
    return value && typeof value.pid === 'number' && typeof value.processStartTime === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function localIdentity(controllerHome: string, epoch: number, probe: ProcessIdentityProbe): SupervisorLockMetadata {
  const pid = process.pid;
  const command = probe.command(pid) ?? process.argv.join(' ');
  const startTime = probe.startTime(pid) ?? new Date().toISOString();
  return {
    pid,
    instanceId: newProcessInstanceId('sup'),
    processStartTime: startTime,
    executableFingerprint: executableFingerprint(command),
    controllerHome,
    ownerEpoch: epoch,
    acquiredAt: new Date().toISOString(),
  };
}

export function nextSupervisorEpoch(previous?: SupervisorState | null): number {
  const old = previous?.supervisor.epoch;
  const candidate = (typeof old === 'number' && Number.isSafeInteger(old) ? old + 1 : Date.now());
  return Math.max(candidate, Date.now());
}

export function acquireSupervisorLock(
  controllerHome: string,
  previousState?: SupervisorState | null,
  probe: ProcessIdentityProbe = defaultProcessIdentityProbe,
): SupervisorLockHandle {
  ensureStableSupervisorLayout(controllerHome);
  const path = supervisorLockPath(controllerHome);
  const epoch = nextSupervisorEpoch(previousState);
  const metadata = localIdentity(controllerHome, epoch, probe);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      closeSync(fd);
      let released = false;
      return {
        metadata,
        release: () => {
          if (released) return;
          released = true;
          const current = readLock(path);
          if (current?.instanceId === metadata.instanceId) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if (!existsSync(path)) {
        if (attempt === 1) throw error;
        continue;
      }
      const existing = readLock(path);
      if (!existing) throw new Error('SUPERVISOR_LOCK_UNCERTAIN: lock metadata cannot prove that the owner is dead');
      const match = processIdentityMatches(existing, existing.pid, probe);
      if (match.matches) throw new Error(`SUPERVISOR_ALREADY_RUNNING: pid=${existing.pid} instance=${existing.instanceId}`);
      // A dead owner or PID-reused process is safe to fence because both the
      // recorded start time and executable fingerprint failed to match.
      rmSync(path, { force: true });
    }
  }
  throw new Error('SUPERVISOR_LOCK_ACQUIRE_FAILED');
}
