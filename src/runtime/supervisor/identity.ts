import { createHash, randomUUID } from 'crypto';
import { runProcess } from '../../effects/process-runner';
import { isProcessAlive } from '../shared/process-tree';
import type { ProcessIdentity } from './types';

export interface ProcessIdentityProbe {
  isAlive(pid: number): boolean;
  command(pid: number): string | undefined;
  startTime(pid: number): string | undefined;
}

const defaultProbe: ProcessIdentityProbe = {
  isAlive: (pid) => isProcessAlive(pid),
  command: (pid) => {
    const result = runProcess('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 1_000, maxOutputBytes: 32 * 1024 });
    return result.ok ? result.stdout.trim() || undefined : undefined;
  },
  startTime: (pid) => {
    const result = runProcess('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 1_000, maxOutputBytes: 4 * 1024 });
    return result.ok ? result.stdout.trim() || undefined : undefined;
  },
};

export function executableFingerprint(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 24);
}

export function newProcessInstanceId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function captureProcessIdentity(
  pid: number | undefined,
  input: Omit<ProcessIdentity, 'pid' | 'processStartTime' | 'executableFingerprint' | 'instanceId'> & { instanceId?: string },
  probe: ProcessIdentityProbe = defaultProbe,
): ProcessIdentity | undefined {
  if (!pid || pid <= 0 || !probe.isAlive(pid)) return undefined;
  const command = probe.command(pid);
  const startTime = probe.startTime(pid);
  if (!command || !startTime) return undefined;
  return {
    pid,
    instanceId: input.instanceId ?? newProcessInstanceId('proc'),
    processStartTime: startTime,
    executableFingerprint: executableFingerprint(command),
    controllerHome: input.controllerHome,
    ...(input.slot ? { slot: input.slot } : {}),
    ...(input.generation ? { generation: input.generation } : {}),
    ...(input.releasePath ? { releasePath: input.releasePath } : {}),
    ...(input.releaseRevision ? { releaseRevision: input.releaseRevision } : {}),
    ownerEpoch: input.ownerEpoch,
  };
}

export function processIdentityMatches(
  expected: ProcessIdentity | undefined,
  actualPid: number | undefined,
  probe: ProcessIdentityProbe = defaultProbe,
): { matches: boolean; reason?: string } {
  if (!expected || !actualPid) return { matches: false, reason: 'identity_missing' };
  if (expected.pid !== actualPid) return { matches: false, reason: 'pid_changed' };
  if (!probe.isAlive(actualPid)) return { matches: false, reason: 'process_dead' };
  const command = probe.command(actualPid);
  const startTime = probe.startTime(actualPid);
  if (!command || !startTime) return { matches: false, reason: 'identity_probe_unavailable' };
  if (startTime !== expected.processStartTime) return { matches: false, reason: 'process_start_time_changed' };
  if (executableFingerprint(command) !== expected.executableFingerprint) {
    return { matches: false, reason: 'executable_fingerprint_changed' };
  }
  return { matches: true };
}

export { defaultProbe as defaultProcessIdentityProbe };
