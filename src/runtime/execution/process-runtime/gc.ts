/**
 * Process Runtime log quota helpers and terminal record GC.
 *
 * - Active processes are never GC'd.
 * - GC requires writer authority.
 * - GC failures must not throw into the controller main loop.
 */

import { existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { ensureRepositoryControllerLayout, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { getProcessRecord, listActiveProcessIds } from './store';
import type { ProcessRuntimeStatus } from './types';
import { assertThisRuntimeMayWrite } from '../../../cli/controller/stable-state/runtime-writer-context';
import { isProcessAlive } from '../../shared/process-tree';

const TERMINAL: ReadonlySet<ProcessRuntimeStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
  'completed_unknown',
]);

export interface ProcessGcOptions {
  controllerHome: string;
  repoId: string;
  /** Keep terminal records newer than this age (default 7d). */
  maxAgeMs?: number;
  /** Max terminal records to retain per repo (default 500). */
  maxTerminalRecords?: number;
  /** Also delete associated log/receipt files. */
  deleteLogs?: boolean;
}

export interface ProcessGcResult {
  ok: boolean;
  removedRecords: number;
  removedLogs: number;
  skippedActive: number;
  error?: string;
}

function processesDir(controllerHome: string, repoId: string): string {
  return join(ensureRepositoryControllerLayout(controllerHome, repoId), 'processes');
}

function logDir(controllerHome: string, repoId: string): string {
  return join(processesDir(controllerHome, repoId), 'logs');
}

function safeUnlink(path: string): boolean {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * GC terminal process records and logs. Never removes active processes.
 * Requires active writer fencing; on fence/error returns ok=false without throwing.
 */
export function gcTerminalProcesses(options: ProcessGcOptions): ProcessGcResult {
  try {
    try {
      const fence = assertThisRuntimeMayWrite('cleanup', options.controllerHome);
      if (!fence.allowed) {
        return {
          ok: false,
          removedRecords: 0,
          removedLogs: 0,
          skippedActive: 0,
          error: `writer_fenced:${fence.reason ?? 'denied'}`,
        };
      }
    } catch {
      /* unbound legacy — allow GC in single-runtime tests */
    }

    const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60_000;
    const maxTerminal = options.maxTerminalRecords ?? 500;
    const root = processesDir(options.controllerHome, options.repoId);
    if (!existsSync(root)) {
      return { ok: true, removedRecords: 0, removedLogs: 0, skippedActive: 0 };
    }

    const active = new Set(listActiveProcessIds(options.controllerHome, options.repoId));
    const terminal: Array<{ processId: string; finishedAt: number; path: string }> = [];
    let skippedActive = 0;

    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json') || name === 'active-index.json') continue;
      const processId = name.slice(0, -'.json'.length);
      if (active.has(processId)) {
        skippedActive += 1;
        continue;
      }
      const record = getProcessRecord(options.controllerHome, options.repoId, processId);
      if (!record) continue;
      // Skip still-alive identity matches even if status drifted.
      if (record.identity && !record.identityUntrusted && !record.identity.processStartTime.startsWith('untrusted:')) {
        try {
          if (isProcessAlive(record.identity.pid)) {
            skippedActive += 1;
            continue;
          }
        } catch {
          /* ignore probe failures */
        }
      }
      if (!TERMINAL.has(record.status)) continue;
      // Do not delete terminal evidence that has never been read when maxAge is not exceeded
      // unless we are strictly over maxTerminalRecords budget (handled by sort below).
      const finished = Date.parse(record.finishedAt ?? record.updatedAt);
      terminal.push({
        processId,
        finishedAt: Number.isFinite(finished) ? finished : 0,
        path: join(root, name),
      });
    }

    terminal.sort((a, b) => b.finishedAt - a.finishedAt);
    const cutoff = Date.now() - maxAgeMs;
    const victims = terminal.filter((entry, index) => index >= maxTerminal || entry.finishedAt < cutoff);

    let removedRecords = 0;
    let removedLogs = 0;
    const logs = logDir(options.controllerHome, options.repoId);
    for (const victim of victims) {
      if (safeUnlink(victim.path)) removedRecords += 1;
      if (options.deleteLogs !== false) {
        for (const suffix of ['.stdout.log', '.stderr.log', '.exit.json']) {
          if (safeUnlink(join(logs, `${victim.processId}${suffix}`))) removedLogs += 1;
        }
      }
    }

    return { ok: true, removedRecords, removedLogs, skippedActive };
  } catch (error) {
    return {
      ok: false,
      removedRecords: 0,
      removedLogs: 0,
      skippedActive: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Best-effort single-process log size check (for diagnostics). */
export function processLogBytes(controllerHome: string, repoId: string, processId: string): number {
  const logs = logDir(controllerHome, repoId);
  let total = 0;
  for (const suffix of ['.stdout.log', '.stderr.log']) {
    const path = join(logs, `${processId}${suffix}`);
    try {
      if (existsSync(path)) total += statSync(path).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

// silence unused import for type-only path helpers
void repositoryControllerRoot;
