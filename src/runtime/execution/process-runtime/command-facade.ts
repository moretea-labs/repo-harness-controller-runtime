/**
 * repository_command_execute → Unified Process Runtime.
 *
 * Short readonly / focused commands: Direct (wait briefly, return result).
 * Longer local build/test: Managed (same spawn, return handle).
 * release / remote / non-idempotent: Durable (caller keeps ExecutionJob path).
 */

import type { RepositoryRecord } from '../../../cli/repositories/types';
import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import { claimsForRepositoryCommand, toProcessClaims } from './resource-claims';
import {
  spawnManagedProcess,
  getProcessHandle,
  waitForProcess,
  cancelProcess,
  readProcessLogs,
} from './runtime';
import type { ProcessHandle, ProcessCommandSpec } from './types';
import { DEFAULT_INTERACTIVE_WAIT_MS } from './types';
import { isFocusedCheckCommand } from '../thin-harness/execution-router';

export type RepositoryCommandRoute =
  | 'process_direct'
  | 'process_managed'
  | 'durable'
  | 'reject';

export interface RepositoryCommandProcessInput {
  controllerHome: string;
  repository: RepositoryRecord;
  command: string | readonly string[];
  cwd?: string;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  maxOutputBytes?: number;
  /** Force durable workflow (async apply, release, remote). */
  forceDurable?: boolean;
  requestId?: string;
  signal?: AbortSignal;
}

export interface RepositoryCommandProcessResult {
  route: RepositoryCommandRoute;
  reason?: string;
  process?: ProcessHandle;
  /** Present for completed direct/managed handles. */
  ok?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
  suggestedOperation?: string;
}

const emptyEffects = {
  executionJobCount: 0,
  localJobCount: 0,
  workerSpawnCount: 0,
  projectionUpdateCount: 0,
};

function toProcessCommand(command: string | readonly string[], cwd: string): ProcessCommandSpec {
  const normalized = normalizeRepositoryCommand(command);
  if (normalized.kind === 'argv') {
    return {
      kind: 'argv',
      executable: normalized.executable,
      args: [...(normalized.args ?? [])],
      cwd,
    };
  }
  return {
    kind: 'shell',
    shellCommand: normalized.shellCommand ?? String(command),
    cwd,
  };
}

/**
 * Decide Direct / Managed / Durable without spawning.
 */
export function classifyRepositoryCommandRoute(
  command: string | readonly string[],
  options: {
    forceDurable?: boolean;
    defaultBranch?: string;
    timeoutMs?: number;
  } = {},
): { route: RepositoryCommandRoute; reason: string } {
  if (options.forceDurable) {
    return { route: 'durable', reason: 'force_durable_or_async' };
  }
  const classification = classifyRepositoryCommand(command, options.defaultBranch);
  if (classification.risk === 'remote_write' || classification.risk === 'destructive') {
    return {
      route: 'durable',
      reason: `risk_${classification.risk}_requires_durable_workflow`,
    };
  }
  // release / rollback style commands
  const text = Array.isArray(command) ? command.join(' ') : String(command);
  if (/\b(?:gh\s+release\s+(?:create|delete|edit|upload)|git\s+push|npm\s+publish)\b/i.test(text)) {
    return { route: 'durable', reason: 'release_or_remote_mutation' };
  }
  if (classification.risk === 'readonly') {
    // Short readonly → direct. Only an *explicit* long timeout upgrades to managed.
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 30_000) {
      return { route: 'process_managed', reason: 'readonly_long_timeout' };
    }
    return { route: 'process_direct', reason: 'readonly_fast_path' };
  }
  // workspace_write / build-test
  if (isFocusedCheckCommand(command) || /\b(?:test|typecheck|lint|build|check)\b/i.test(text)) {
    return { route: 'process_managed', reason: 'local_build_or_test' };
  }
  // Unknown mutating local command — managed process with workspace write claims,
  // not a second executor. Extremely long / approval-gated still durable.
  if (options.timeoutMs && options.timeoutMs > 15 * 60_000) {
    return { route: 'durable', reason: 'very_long_timeout_requires_durable' };
  }
  return { route: 'process_managed', reason: 'local_workspace_mutation' };
}

/**
 * Execute via Unified Process Runtime when route is process_*.
 * Does not create ExecutionJob / LocalJob / Worker.
 */
export async function executeRepositoryCommandViaProcessRuntime(
  input: RepositoryCommandProcessInput,
): Promise<RepositoryCommandProcessResult> {
  const decision = classifyRepositoryCommandRoute(input.command, {
    forceDurable: input.forceDurable,
    defaultBranch: input.repository.defaultBranch,
    timeoutMs: input.timeoutMs,
  });

  if (decision.route === 'durable' || decision.route === 'reject') {
    return {
      route: decision.route,
      reason: decision.reason,
      durableSideEffects: emptyEffects,
      suggestedOperation: 'repository_command_execute via Durable Work / Local Job',
    };
  }

  const cwd = input.cwd?.trim()
    || input.repository.localRoot
    || input.repository.canonicalRoot;
  if (!cwd) {
    return {
      route: 'reject',
      reason: 'missing_repository_cwd',
      durableSideEffects: emptyEffects,
    };
  }

  const interactiveWaitMs = decision.route === 'process_direct'
    ? (input.interactiveWaitMs ?? DEFAULT_INTERACTIVE_WAIT_MS)
    : (input.interactiveWaitMs ?? Math.min(DEFAULT_INTERACTIVE_WAIT_MS, 2_000));
  const timeoutMs = Math.max(
    interactiveWaitMs + 1,
    Math.min(input.timeoutMs ?? 15 * 60_000, 24 * 60 * 60_000),
  );

  const claims = claimsForRepositoryCommand(
    input.command,
    input.repository.repoId,
    input.repository.activeCheckoutId,
    input.repository.defaultBranch,
  );

  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: input.repository.repoId,
    checkoutId: input.repository.activeCheckoutId,
    command: toProcessCommand(input.command, cwd),
    interactiveWaitMs: decision.route === 'process_direct' ? interactiveWaitMs : 0,
    timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    resourceClaims: toProcessClaims(claims),
    origin: {
      surface: 'command',
      toolName: 'repository_command_execute',
      requestId: input.requestId,
    },
    signal: input.signal,
    returnHandleImmediately: decision.route === 'process_managed' && interactiveWaitMs === 0,
  });

  const route: RepositoryCommandRoute = handle.completed ? 'process_direct' : 'process_managed';
  return {
    route,
    reason: decision.reason,
    process: handle,
    ok: handle.ok,
    exitCode: handle.exitCode,
    stdout: handle.stdout,
    stderr: handle.stderr,
    durableSideEffects: handle.durableSideEffects,
  };
}

export {
  getProcessHandle as getRepositoryCommandProcess,
  waitForProcess as waitRepositoryCommandProcess,
  cancelProcess as cancelRepositoryCommandProcess,
  readProcessLogs as readRepositoryCommandProcessLogs,
};
