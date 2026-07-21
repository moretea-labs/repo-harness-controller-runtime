/**
 * Lightweight run_check facade.
 *
 * Short checks complete via Process Runtime and return results directly.
 * Long checks return a Managed Process handle for the same OS process.
 * Only multi-phase / release / recovery checks remain Durable Workflow.
 */

import {
  listControllerChecks,
  snapshotControllerCheck,
  type ControllerCheck,
  type ControllerCheckSnapshot,
} from '../../../cli/controller/check-runner';
import { claimsForCheck, toProcessClaims } from './resource-claims';
import { spawnManagedProcess, waitForProcess, getProcessHandle } from './runtime';
import type { ProcessHandle } from './types';
import { DEFAULT_INTERACTIVE_WAIT_MS } from './types';

export type CheckExecutionMode = 'direct' | 'managed' | 'durable';

export interface RunCheckFacadeInput {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  repoRoot: string;
  checkId: string;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  requestId?: string;
  /** Force durable workflow (release / multi-phase). */
  forceDurable?: boolean;
  signal?: AbortSignal;
}

export interface RunCheckFacadeResult {
  mode: CheckExecutionMode;
  checkId: string;
  check?: ControllerCheck;
  /** Present when mode is direct or managed. */
  process?: ProcessHandle;
  /** Present when mode is durable — caller must create ExecutionJob. */
  durable?: {
    reason: string;
    suggestedOperation: string;
  };
  ok?: boolean;
  /** Zero job side effects for process path. */
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
}

const DURABLE_CHECK_ID = /(?:^|:)(?:release|migration|integrate|controller-v8|public-export|deploy)(?:$|:)/i;

/**
 * True when a check must stay on Durable Workflow (multi-phase / release).
 * Ordinary typecheck / lint / package test / focused validation stay on Process Runtime.
 */
export function checkRequiresDurableWorkflow(checkId: string, check?: ControllerCheck): boolean {
  if (DURABLE_CHECK_ID.test(checkId)) return true;
  if (check && /release|rollback|blue.?green|migrate/i.test(check.description)) return true;
  return false;
}

function resolveCheck(repoRoot: string, checkId: string): ControllerCheck | undefined {
  return listControllerChecks(repoRoot).find((entry) => entry.id === checkId);
}

/**
 * Run a configured check through Unified Process Runtime when eligible.
 * Does not create ExecutionJob / LocalBridgeJob / Worker.
 */
export async function runCheckViaProcessRuntime(
  input: RunCheckFacadeInput,
): Promise<RunCheckFacadeResult> {
  const emptyEffects = {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };

  const check = resolveCheck(input.repoRoot, input.checkId);
  if (!check) {
    return {
      mode: 'durable',
      checkId: input.checkId,
      durable: {
        reason: 'check_not_found_or_requires_registry_lookup',
        suggestedOperation: 'list_checks then run_check with a known check_id',
      },
      durableSideEffects: emptyEffects,
    };
  }

  if (input.forceDurable || checkRequiresDurableWorkflow(input.checkId, check)) {
    return {
      mode: 'durable',
      checkId: input.checkId,
      check,
      durable: {
        reason: 'multi_phase_or_release_check_requires_durable_workflow',
        suggestedOperation: 'run_check via Durable Work (ExecutionJob)',
      },
      durableSideEffects: emptyEffects,
    };
  }

  // Checks often outlive a short interactive window; default to a brief wait so
  // MCP stays responsive and returns a Managed handle for the same OS process.
  // Keep well under 2s so controller MCP tests and ChatGPT tool UX stay snappy.
  const interactiveWaitMs = input.interactiveWaitMs ?? Math.min(800, DEFAULT_INTERACTIVE_WAIT_MS);
  const timeoutMs = Math.min(
    check.timeoutMs,
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(1_000, Math.trunc(input.timeoutMs))
      : check.timeoutMs,
  );
  const claims = claimsForCheck(input.checkId, check.command, input.repoId, input.checkoutId);
  const cwd = check.cwd === '.' ? input.repoRoot : `${input.repoRoot}/${check.cwd}`.replace(/\/+/g, '/');

  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    command: {
      kind: 'argv',
      executable: check.command[0],
      args: check.command.slice(1),
      cwd,
    },
    interactiveWaitMs,
    timeoutMs,
    resourceClaims: toProcessClaims(claims),
    origin: {
      surface: 'check',
      toolName: 'run_check',
      checkId: input.checkId,
      requestId: input.requestId,
    },
    signal: input.signal,
  });

  const mode: CheckExecutionMode = handle.completed ? 'direct' : 'managed';
  return {
    mode,
    checkId: input.checkId,
    check,
    process: handle,
    ok: handle.completed ? handle.ok : undefined,
    durableSideEffects: handle.durableSideEffects,
  };
}

export async function waitForCheckProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
  timeoutMs?: number,
): Promise<ProcessHandle> {
  return waitForProcess(controllerHome, repoId, processId, { timeoutMs });
}

export function getCheckProcessHandle(
  controllerHome: string,
  repoId: string,
  processId: string,
): ProcessHandle | undefined {
  return getProcessHandle(controllerHome, repoId, processId);
}

/** Snapshot helper re-export for durable fallback path compatibility. */
export function snapshotCheck(repoRoot: string, checkId: string): ControllerCheckSnapshot {
  return snapshotControllerCheck(repoRoot, checkId);
}
