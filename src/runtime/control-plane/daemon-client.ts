import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { withControllerLock } from '../../cli/repositories/locks';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { readSchedulerHealthSnapshot } from './global-scheduler/scheduler';
import { cleanupControllerRuntimeState } from './runtime-cleanup';
import type { ControllerStartupRecoveryResult } from './startup-recovery';

export interface ControllerDaemonStatus {
  schemaVersion: 1;
  status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unavailable';
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
  gatewaySeparated?: boolean;
  workerIsolation?: boolean;
  degraded?: boolean;
  recovery?: ControllerStartupRecoveryResult;
}

function daemonPidPath(controllerHome: string): string { return join(ensureControllerHome(controllerHome), 'daemon', 'controller.pid'); }
function daemonStatePath(controllerHome: string): string { return join(ensureControllerHome(controllerHome), 'daemon', 'state.json'); }
const SCHEDULER_HEARTBEAT_STALE_MS = 5_000;
const DAEMON_STARTUP_GRACE_MS = 15_000;

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function schedulerHeartbeatHealthy(controllerHome: string): boolean {
  const scheduler = readSchedulerHealthSnapshot(controllerHome);
  if (!scheduler.loopStartedAt || !scheduler.lastTickAt) return false;
  const lastTick = Date.parse(scheduler.lastTickAt);
  return Number.isFinite(lastTick) && Date.now() - lastTick <= SCHEDULER_HEARTBEAT_STALE_MS;
}

export function readControllerDaemonStatus(controllerHome: string): ControllerDaemonStatus {
  const home = ensureControllerHome(controllerHome);
  const state = readJsonFile<ControllerDaemonStatus>(daemonStatePath(home), { schemaVersion: 1, status: 'unavailable' });
  let pid = state.pid;
  try { pid = Number(readFileSync(daemonPidPath(home), 'utf8').trim()) || pid; } catch { /* no pid */ }
  if ((state.status === 'ready' || state.status === 'starting') && !pidAlive(pid)) return { ...state, status: 'stopped', pid };
  if (state.status === 'ready' && !schedulerHeartbeatHealthy(home)) {
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
    if (Number.isFinite(startedAt) && Date.now() - startedAt < DAEMON_STARTUP_GRACE_MS) {
      return { ...state, status: 'starting', pid };
    }
    // A stale scheduler heartbeat is degraded runtime state, not proof that the
    // daemon process is dead. Keep the live PID authoritative so callers do not
    // spawn a second daemon and invalidate Workers owned by the first one.
    return {
      ...state,
      status: 'ready',
      pid,
      degraded: true,
      error: state.error ?? 'SCHEDULER_HEARTBEAT_STALE',
    };
  }
  return { ...state, pid };
}

export function ensureControllerDaemon(controllerHome: string): ControllerDaemonStatus {
  const home = ensureControllerHome(controllerHome);
  // Cleanup is bounded but still performs filesystem I/O. Run it before taking
  // the global daemon-start lock so unrelated Controller operations are not blocked.
  try {
    cleanupControllerRuntimeState(home, { reason: 'startup' });
  } catch (error) {
    console.error('[repo-harness cleanup] startup cleanup failed:', error);
  }
  return withControllerLock(home, { scope: 'global' }, 'ensure-controller-daemon', () => {
    const current = readControllerDaemonStatus(home);
    // PID liveness is the fencing boundary. A degraded/stale heartbeat must not
    // create a competing daemon while the recorded process is still alive.
    if (pidAlive(current.pid)) return current;
    const entry = fileURLToPath(new URL('./daemon-entry.ts', import.meta.url));
    const bun = Boolean(process.versions.bun);
    const loader = fileURLToPath(new URL('../shared/node-ts-loader.mjs', import.meta.url));
    const args = bun
      ? [entry, '--controller-home', home]
      : ['--loader', loader, entry, '--controller-home', home];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    const starting: ControllerDaemonStatus = {
      schemaVersion: 1,
      status: 'starting',
      pid: child.pid,
      startedAt: new Date().toISOString(),
      gatewaySeparated: true,
      workerIsolation: true,
    };
    // Persist the spawn intent before releasing the global lock. Concurrent
    // Gateway requests will observe this PID instead of starting another daemon.
    writeJsonAtomic(daemonStatePath(home), starting);
    if (child.pid) writeFileSync(daemonPidPath(home), `${child.pid}\n`, 'utf8');
    child.once('error', (error) => {
      writeJsonAtomic(daemonStatePath(home), { ...starting, status: 'failed', error: error.message });
    });
    child.unref();
    return starting;
  }, 10_000);
}

export function controllerDaemonPidExists(controllerHome: string): boolean {
  return existsSync(daemonPidPath(controllerHome));
}
