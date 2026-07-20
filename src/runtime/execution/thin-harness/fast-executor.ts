import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { applySafePatch } from '../../../cli/repositories/safe-patch';
import { repositoryGitCommit } from '../../../cli/repositories/structured-git';
import {
  executeRepositoryCommandAsync,
  previewRepositoryCommandExecutionAsync,
  type RepositoryCommandSnapshot,
} from '../../../cli/repositories/command-executor';
import { getMcpPolicy } from '../../../cli/mcp/policy';
import { readRepositoryRange } from '../../../cli/repository/inspector';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getLeaseSideEffectMetrics } from '../../resources/leases/store';
import { runBoundedGit, runBoundedProcess } from './async-process';
import { extractPatchPaths, pathAllowed, routeExecution } from './execution-router';
import { LatencyTrace } from './latency-trace';
import {
  hashRequestInput,
  writeFastReceipt,
} from './fast-receipt';
import {
  mutationGateBusyMessage,
  withCheckoutMutationGate,
  type CheckoutMutationGate,
  type MutationGateHelpers,
  type MutationOwnershipOptions,
} from './mutation-gate';
import {
  beginFastRequest,
  completeFastRequest,
  heartbeatFastRequest,
  type FastRequestLedgerEntry,
} from './request-ledger';
import { runInspectorSearchInWorker } from './search-worker';
import {
  createWorkspaceSavepoint,
  discardWorkspaceSavepoint,
  restoreWorkspaceSavepoint,
  verifySavepointRestored,
  type WorkspaceSavepoint,
} from './workspace-savepoint';
import {
  FAST_PATH_DEFAULT_TIMEOUT_MS,
  FAST_PATH_MAX_FILE_BYTES,
  FAST_PATH_MAX_OUTPUT_BYTES,
  FAST_PATH_MAX_TIMEOUT_MS,
  type ExecutionDecision,
  type FastExecutionReceipt,
  type FastOperationKind,
  type FastOutcome,
  type LatencyBreakdown,
  type ReceiptMode,
} from './types';

export interface FastExecutorContext {
  controllerHome: string;
  repository: RepositoryRecord;
  includeLatencyBreakdown?: boolean;
  principalId?: string;
  sessionId?: string;
}

export interface FastExecuteInput {
  operation: FastOperationKind | string;
  mode?: 'auto' | 'fast' | 'durable';
  input: Record<string, unknown>;
  background?: boolean;
  timeoutMs?: number;
  allowedPaths?: string[];
  receiptMode?: ReceiptMode;
  requestId?: string;
  signal?: AbortSignal;
  /** When set, reuses outer mutation gate (batch). */
  externalMutation?: boolean;
  /** Outer gate fencing + helpers for batch steps. */
  externalGate?: CheckoutMutationGate;
  externalHelpers?: MutationGateHelpers;
}

export interface FastExecuteResult {
  ok: boolean;
  decision: ExecutionDecision;
  receipt?: FastExecutionReceipt;
  receiptPersisted?: boolean;
  receiptWarning?: string;
  operationSucceeded?: boolean;
  changedPaths?: string[];
  repositoryChanged?: boolean;
  outcome?: FastOutcome | 'unknown';
  result?: Record<string, unknown>;
  latency: LatencyBreakdown;
  escalation?: { reason: string; suggestedOperation: string };
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
    schedulerWakeCount?: number;
    runtimeEventCount?: number;
    ephemeralLeaseAcquireCount?: number;
  };
  ledgerPersisted?: boolean;
  ledgerWarning?: string;
  reconciliationRequired?: boolean;
  cleanupRequired?: boolean;
  processStopUnconfirmed?: boolean;
}

function boundedTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FAST_PATH_DEFAULT_TIMEOUT_MS;
  return Math.max(100, Math.min(Math.trunc(value), FAST_PATH_MAX_TIMEOUT_MS));
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String).filter(Boolean);
}

function policyFor(repoRoot: string) {
  return getMcpPolicy('controller', { repoRoot });
}

function summaryFrom(value: unknown, max = 512): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length <= max ? text : `${text.slice(0, max)}…`;
  } catch {
    return '[unserializable]';
  }
}

function observedSideEffects(before: ReturnType<typeof getLeaseSideEffectMetrics>) {
  const after = getLeaseSideEffectMetrics();
  return {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    // Real instrumentation — ephemeral Fast leases must keep these at 0.
    projectionUpdateCount: Math.max(0, after.projectionDirtyMarks - before.projectionDirtyMarks),
    schedulerWakeCount: Math.max(0, after.schedulerWakes - before.schedulerWakes),
    runtimeEventCount: Math.max(0,
      (after.durableAcquireEvents + after.durableReleaseEvents)
      - (before.durableAcquireEvents + before.durableReleaseEvents)),
    ephemeralLeaseAcquireCount: Math.max(0, after.ephemeralAcquires - before.ephemeralAcquires),
  };
}

function emptyDecision(partial: Partial<ExecutionDecision> & Pick<ExecutionDecision, 'mode' | 'reasons'>): ExecutionDecision {
  return {
    risk: 'unknown',
    estimatedClass: 'short',
    requiresIsolation: false,
    requiresRecovery: false,
    effects: {
      readsWorkspace: true,
      mutatesWorkspace: false,
      mutatesGitRefs: false,
      remoteWrite: false,
    },
    ...partial,
  };
}

async function asyncGitStatus(
  repoRoot: string,
  repoId: string,
  checkoutId: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const [porcelain, branch, head, shortStatus] = await Promise.all([
    runBoundedGit(repoRoot, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**'], {
      timeoutMs, maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES, signal,
    }),
    runBoundedGit(repoRoot, ['branch', '--show-current'], { timeoutMs, maxOutputBytes: 4_096, signal }),
    runBoundedGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], { timeoutMs, maxOutputBytes: 4_096, signal }),
    runBoundedGit(repoRoot, ['status', '--short', '--branch', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**'], {
      timeoutMs, maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES, signal,
    }),
  ]);

  const required = [porcelain, head];
  for (const result of required) {
    if (result.cancelled) throw new Error('CANCELLED: git status cancelled');
    if (result.timedOut) throw new Error('GIT_STATUS_TIMEOUT: git status timed out');
    if (!result.ok && result.exitCode !== 0) {
      throw new Error(`GIT_STATUS_FAILED: ${result.stderr || `exit ${result.exitCode}`}`);
    }
  }

  const lines = porcelain.stdout.split(/\r?\n/);
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith('## ')) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (code === '??') untracked.push(path);
    else {
      if (code[0] !== ' ' && code[0] !== '?') staged.push(path);
      if (code[1] !== ' ' && code[1] !== '?') unstaged.push(path);
    }
  }
  return {
    status: {
      repoId,
      checkoutId,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      head: head.ok ? head.stdout.trim() || null : null,
      upstream: null,
      porcelain: porcelain.stdout,
      shortStatus: shortStatus.ok ? shortStatus.stdout : porcelain.stdout,
      staged,
      unstaged,
      untracked,
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    },
  };
}

async function asyncGitDiff(
  repoRoot: string,
  repoId: string,
  checkoutId: string,
  input: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const staged = input.staged === true;
  const paths = stringList(input.paths) ?? [];
  const maxBytes = typeof input.max_bytes === 'number' ? Math.min(input.max_bytes, FAST_PATH_MAX_OUTPUT_BYTES) : FAST_PATH_MAX_OUTPUT_BYTES;
  const prefix = ['diff', ...(staged ? ['--cached'] : [])];
  const separator = paths.length > 0 ? ['--', ...paths] : [];
  const [nameOnly, stat, patch, branch, head] = await Promise.all([
    runBoundedGit(repoRoot, [...prefix, '--name-only', ...separator], { timeoutMs, maxOutputBytes: maxBytes, signal }),
    runBoundedGit(repoRoot, [...prefix, '--stat', ...separator], { timeoutMs, maxOutputBytes: maxBytes, signal }),
    runBoundedGit(repoRoot, [...prefix, ...separator], { timeoutMs, maxOutputBytes: maxBytes, signal }),
    runBoundedGit(repoRoot, ['branch', '--show-current'], { timeoutMs, maxOutputBytes: 4_096, signal }),
    runBoundedGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], { timeoutMs, maxOutputBytes: 4_096, signal }),
  ]);

  for (const result of [nameOnly, patch, head]) {
    if (result.cancelled) throw new Error('CANCELLED: git diff cancelled');
    if (result.timedOut) throw new Error('GIT_DIFF_TIMEOUT: git diff timed out');
    if (!result.ok && result.exitCode !== 0) {
      throw new Error(`GIT_DIFF_FAILED: ${result.stderr || `exit ${result.exitCode}`}`);
    }
  }

  return {
    diff: {
      repoId,
      checkoutId,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      head: head.ok ? head.stdout.trim() || null : null,
      staged,
      paths,
      nameOnly: nameOnly.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      stat: stat.stdout,
      patch: patch.stdout,
      truncated: false,
    },
  };
}

async function runSearchInWorker(
  repoRoot: string,
  query: string,
  maxResults: number,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const rg = await runBoundedProcess('rg', [
    '--line-number',
    '--no-heading',
    '--color', 'never',
    '--max-count', String(maxResults),
    '--max-filesize', '512K',
    '-g', '!node_modules',
    '-g', '!.git',
    '-g', '!.ai/harness',
    query,
    '.',
  ], {
    cwd: repoRoot,
    timeoutMs: FAST_PATH_DEFAULT_TIMEOUT_MS,
    maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
    signal,
  });
  if (rg.ok || rg.exitCode === 1) {
    const results = rg.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, maxResults)
      .map((line) => {
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!match) return undefined;
        return { path: match[1]!, line: Number(match[2]), text: match[3]!.slice(0, 500) };
      })
      .filter(Boolean);
    return {
      query,
      results,
      scannedFiles: results.length,
      policyDeniedFiles: 0,
      skippedLargeFiles: 0,
      skippedBinaryFiles: 0,
      truncated: results.length >= maxResults,
      engine: 'rg',
    };
  }
  // No rg (or hard failure): Worker Thread inspector fallback — never sync on Gateway loop.
  if (signal?.aborted) throw new Error('CANCELLED: search aborted');
  return runInspectorSearchInWorker(
    { repoRoot, query, maxResults, maxFiles },
    { timeoutMs: FAST_PATH_DEFAULT_TIMEOUT_MS, signal },
  );
}

function ownershipOptionsFor(
  operation: string,
  decision: ExecutionDecision,
  input: Record<string, unknown>,
): MutationOwnershipOptions {
  const writePaths = [
    ...(Array.isArray(input.paths) ? input.paths.map(String) : []),
    ...extractPatchPaths(input.operations),
    ...(Array.isArray(input.allowed_paths) ? input.allowed_paths.map(String) : []),
  ];
  return {
    writePaths: writePaths.length ? writePaths : undefined,
    mutatesGitRefs: decision.effects.mutatesGitRefs
      || operation.includes('commit')
      || operation === 'repository_git_commit',
    mutatesGitIndex: decision.effects.mutatesWorkspace || decision.effects.mutatesGitRefs,
  };
}

/**
 * Execute one Fast Path operation without ExecutionJob / Local Job / Worker / Campaign.
 */
export async function executeFast(
  ctx: FastExecutorContext,
  request: FastExecuteInput,
): Promise<FastExecuteResult> {
  const startedAt = new Date().toISOString();
  const trace = new LatencyTrace('fast');
  const sideEffectsBefore = getLeaseSideEffectMetrics();
  const receiptMode = request.receiptMode ?? 'standalone';
  const requestId = request.requestId?.trim() || undefined;
  const inputHash = hashRequestInput({ operation: request.operation, input: request.input });
  const owner = `fast:${ctx.sessionId ?? 'anon'}:${request.operation}:${requestId ?? Date.now()}`;

  const patchPaths = extractPatchPaths(request.input.operations);
  const decision = trace.measureSync('routingMs', () => routeExecution({
    operation: request.operation,
    mode: request.mode ?? 'auto',
    background: request.background,
    timeoutMs: request.timeoutMs,
    command: request.input.command as string | string[] | undefined,
    paths: stringList(request.input.paths) ?? stringList(request.input.changed_paths),
    patchPaths,
    allowedPaths: request.allowedPaths ?? stringList(request.input.allowed_paths),
    patchOperationCount: Array.isArray(request.input.operations) ? request.input.operations.length : undefined,
    defaultBranch: ctx.repository.defaultBranch,
    requiresIsolation: request.input.requires_isolation === true,
    requiresRecovery: request.input.requires_recovery === true,
    requiresWorktree: request.input.isolation === 'new_worktree',
    agentRun: request.input.agent_run === true,
    remoteWrite: request.input.remote_write === true,
    concurrentWriteLanes: request.input.concurrent_write_lanes === true,
  }));

  if (decision.mode === 'reject') {
    return {
      ok: false,
      decision,
      operationSucceeded: false,
      latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
      durableSideEffects: observedSideEffects(sideEffectsBefore),
      result: { error: { code: decision.rejectCode ?? 'FAST_REJECTED', message: decision.reasons.join('; ') } },
    };
  }
  if (decision.mode === 'durable') {
    return {
      ok: false,
      decision,
      operationSucceeded: false,
      latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
      escalation: {
        reason: decision.reasons.join('; '),
        suggestedOperation: decision.suggestedOperation ?? 'Durable Work',
      },
      durableSideEffects: observedSideEffects(sideEffectsBefore),
      result: {
        mode: 'durable',
        reason: decision.reasons.join('; '),
        suggestedOperation: decision.suggestedOperation,
        message: 'Fast Path declined. Open an explicit Durable Work request; partial fast steps were not executed.',
      },
    };
  }

  if (request.signal?.aborted) {
    return {
      ok: false,
      decision,
      operationSucceeded: false,
      latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
      durableSideEffects: observedSideEffects(sideEffectsBefore),
      result: { error: { code: 'CANCELLED', message: 'aborted before execution' } },
    };
  }

  const operation = request.operation;
  const needsMutation = decision.effects.mutatesWorkspace || decision.effects.mutatesGitRefs;
  const isExplicitWriteOp = [
    'apply_patch', 'repository_safe_patch_apply', 'apply_edit_operations',
    'stage_paths', 'git_stage_paths', 'commit_paths', 'git_commit_paths', 'repository_git_commit',
  ].includes(String(operation));

  // Mutations without requestId must not default to Fast for non-idempotent ops.
  if (needsMutation && isExplicitWriteOp && !requestId && receiptMode === 'standalone' && !request.externalMutation) {
    if (['commit_paths', 'git_commit_paths', 'repository_git_commit', 'stage_paths', 'git_stage_paths'].includes(String(operation))) {
      return {
        ok: false,
        decision: emptyDecision({
          mode: 'durable',
          reasons: ['mutation_requires_request_id_for_idempotency'],
          risk: 'workspace_write',
          effects: decision.effects,
          suggestedOperation: 're-issue with request_id or Durable Work',
        }),
        operationSucceeded: false,
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: observedSideEffects(sideEffectsBefore),
        escalation: {
          reason: 'stage/commit require request_id for Fast Path idempotency',
          suggestedOperation: 'provide request_id or use Durable Work',
        },
        result: {
          error: {
            code: 'REQUEST_ID_REQUIRED',
            message: 'stage/commit on Fast Path require request_id',
          },
        },
      };
    }
  }

  // Atomic request ledger before mutation.
  let ledgerEntry: ReturnType<typeof beginFastRequest> | undefined;
  let acquiredLedger: FastRequestLedgerEntry | undefined;
  if (requestId && needsMutation && receiptMode === 'standalone' && !request.externalMutation) {
    ledgerEntry = beginFastRequest({
      controllerHome: ctx.controllerHome,
      repoId: ctx.repository.repoId,
      checkoutId: ctx.repository.activeCheckoutId,
      requestId,
      inputHash,
      operation: String(operation),
      owner,
      ownerSessionId: ctx.sessionId,
    });
    if (ledgerEntry.kind === 'acquired') {
      acquiredLedger = ledgerEntry.entry;
    }
    if (ledgerEntry.kind === 'replay') {
      return {
        ok: true,
        decision: emptyDecision({
          mode: 'fast',
          reasons: ['idempotent_replay'],
          effects: decision.effects,
        }),
        receiptPersisted: true,
        operationSucceeded: true,
        result: {
          replayed: true,
          requestId,
          entryId: ledgerEntry.entry.entryId,
          resultSummary: ledgerEntry.entry.resultSummary,
          receiptExecutionId: ledgerEntry.entry.receiptExecutionId,
        },
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: observedSideEffects(sideEffectsBefore),
      };
    }
    if (ledgerEntry.kind === 'in_progress') {
      return {
        ok: false,
        decision: emptyDecision({
          mode: 'fast',
          reasons: ['idempotent_in_progress'],
          effects: decision.effects,
        }),
        operationSucceeded: false,
        result: {
          error: {
            code: 'REQUEST_IN_PROGRESS',
            message: `requestId ${requestId} is already in progress`,
            entryId: ledgerEntry.entry.entryId,
          },
        },
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: observedSideEffects(sideEffectsBefore),
      };
    }
    if (ledgerEntry.kind === 'unknown') {
      return {
        ok: false,
        decision: emptyDecision({
          mode: 'durable',
          reasons: ['ledger_unknown_requires_reconcile'],
          effects: decision.effects,
          suggestedOperation: 'reconcile stale ledger before retry',
        }),
        operationSucceeded: false,
        result: {
          error: {
            code: 'LEDGER_UNKNOWN',
            message: ledgerEntry.message,
            entryId: ledgerEntry.entry.entryId,
          },
        },
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: observedSideEffects(sideEffectsBefore),
      };
    }
    if (ledgerEntry.kind === 'conflict') {
      return {
        ok: false,
        decision: emptyDecision({
          mode: 'reject',
          reasons: ['idempotency_conflict'],
          rejectCode: 'IDEMPOTENCY_CONFLICT',
          effects: decision.effects,
        }),
        operationSucceeded: false,
        result: {
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: ledgerEntry.message,
          },
        },
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: observedSideEffects(sideEffectsBefore),
      };
    }
  }

  const timeoutMs = boundedTimeout(request.timeoutMs ?? (typeof request.input.timeout_ms === 'number' ? request.input.timeout_ms : undefined));
  const root = ctx.repository.canonicalRoot;

  const runBody = async (
    fencingToken?: number,
    baseHead?: string | null,
    helpers?: MutationGateHelpers,
    effectiveSignal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    outcome: FastOutcome;
    changedPaths: string[];
    repositoryChanged: boolean;
    resultPayload: Record<string, unknown>;
    authorizationDecision: string;
    policyDecision: string;
  }> => {
    let outcome: FastOutcome = 'succeeded';
    let changedPaths: string[] = [];
    let repositoryChanged = false;
    let resultPayload: Record<string, unknown> = {};
    let authorizationDecision = 'policy';
    let policyDecision = 'allowed';
    let ok = true;

    const signal = effectiveSignal ?? request.signal;
    try {
      helpers?.assert();
      if (operation === 'read_file' || operation === 'read_file_range') {
        const path = String(request.input.path ?? '');
        const absolute = join(root, path);
        if (existsSync(absolute)) {
          const size = statSync(absolute).size;
          if (size > FAST_PATH_MAX_FILE_BYTES) {
            throw new Error(`FILE_TOO_LARGE: ${path} exceeds ${FAST_PATH_MAX_FILE_BYTES} bytes`);
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
        resultPayload = trace.measureSync('executionMs', () => {
          const startLine = typeof request.input.start_line === 'number' ? request.input.start_line : 1;
          const endLine = typeof request.input.end_line === 'number' ? request.input.end_line : startLine + 199;
          return readRepositoryRange(root, policyFor(root), path, startLine, endLine, {
            sessionId: ctx.sessionId ?? 'fast',
            repoId: ctx.repository.repoId,
            checkoutId: ctx.repository.activeCheckoutId,
          }) as unknown as Record<string, unknown>;
        });
      } else if (operation === 'search' || operation === 'search_repository') {
        resultPayload = await trace.measure('executionMs', async () => runSearchInWorker(
          root,
          String(request.input.query ?? ''),
          typeof request.input.max_results === 'number' ? request.input.max_results : 50,
          typeof request.input.max_files === 'number' ? request.input.max_files : 2_000,
          signal,
        ));
      } else if (operation === 'git_status' || operation === 'repository_git_status') {
        resultPayload = await trace.measure('snapshotMs', async () => asyncGitStatus(
          root,
          ctx.repository.repoId,
          ctx.repository.activeCheckoutId,
          timeoutMs,
          signal,
        ));
      } else if (operation === 'git_diff' || operation === 'repository_git_diff' || operation === 'git_diff_paths') {
        resultPayload = await trace.measure('executionMs', async () => asyncGitDiff(
          root,
          ctx.repository.repoId,
          ctx.repository.activeCheckoutId,
          request.input,
          timeoutMs,
          signal,
        ));
      } else if (operation === 'apply_patch' || operation === 'repository_safe_patch_apply' || operation === 'apply_edit_operations') {
        helpers?.assert();
        if (signal?.aborted) throw new Error('CANCELLED: ownership or request aborted');
        const allowed = request.allowedPaths ?? stringList(request.input.allowed_paths);
        const opPaths = extractPatchPaths(request.input.operations);
        if (allowed?.length) {
          const bad = opPaths.filter((path) => !pathAllowed(path, allowed));
          if (bad.length > 0) {
            throw new Error(`PATH_SCOPE_REJECTED: operations target paths outside allowed scope: ${bad.join(', ')}`);
          }
        }
        // Create binary-safe savepoint (files, symlinks, modes, create/delete) before apply.
        let savepoint: WorkspaceSavepoint | undefined;
        try {
          savepoint = createWorkspaceSavepoint({
            controllerHome: ctx.controllerHome,
            repoId: ctx.repository.repoId,
            repoRoot: root,
            paths: opPaths,
          });
        } catch (error) {
          throw new Error(
            `SAVEPOINT_CREATE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        let applied: ReturnType<typeof applySafePatch>;
        try {
          helpers?.assert();
          applied = await trace.measure('executionMs', async () => applySafePatch(ctx.repository, {
            sessionId: request.input.session_id,
            purpose: request.input.purpose ?? 'fast-path-patch',
            operations: request.input.operations,
            chunkSize: request.input.chunk_size,
            expectedRevision: request.input.expected_revision,
            allowedPaths: allowed,
            continueOnError: false,
            refreshFingerprints: request.input.refresh_fingerprints !== false,
            recoverStaleSession: request.input.recover_stale_session !== false,
          }));
        } catch (error) {
          const restored = restoreWorkspaceSavepoint(savepoint);
          const verified = verifySavepointRestored(root, savepoint);
          if (!restored.ok || !verified.ok) {
            resultPayload = {
              error: {
                code: 'PATCH_ROLLBACK_INCOMPLETE',
                message: error instanceof Error ? error.message : String(error),
                repositoryChanged: true,
                cleanupRequired: true,
                reconciliationRequired: true,
                failedPaths: restored.failedPaths,
                residual: verified.residual,
              },
            };
            ok = false;
            outcome = 'failed';
            repositoryChanged = true;
            changedPaths = [...new Set([...restored.failedPaths, ...verified.residual])];
            policyDecision = 'rollback_incomplete';
            // Do not discard savepoint on incomplete restore.
            return {
              ok,
              outcome,
              changedPaths,
              repositoryChanged,
              resultPayload,
              authorizationDecision: String(authorizationDecision),
              policyDecision,
            };
          }
          discardWorkspaceSavepoint(savepoint);
          throw error;
        }
        changedPaths = [...new Set((applied.appliedChunks ?? []).flatMap((chunk) => chunk.paths ?? []))];
        repositoryChanged = changedPaths.length > 0;
        ok = applied.status === 'applied';
        outcome = ok ? 'succeeded' : 'failed';
        policyDecision = ok ? 'allowed' : 'failed';

        const needsRollback = !ok || (allowed?.length
          ? changedPaths.some((path) => !pathAllowed(path, allowed))
          : false);

        if (needsRollback) {
          const outOfScope = allowed?.length
            ? changedPaths.filter((path) => !pathAllowed(path, allowed))
            : [];
          const restored = restoreWorkspaceSavepoint(savepoint);
          const verified = verifySavepointRestored(root, savepoint);
          const rollbackOk = restored.ok && verified.ok;
          ok = false;
          outcome = 'failed';
          if (rollbackOk) {
            policyDecision = outOfScope.length
              ? 'path_scope_violation_rolled_back'
              : 'patch_failed_rolled_back';
            repositoryChanged = false;
            changedPaths = [];
            discardWorkspaceSavepoint(savepoint);
            resultPayload = {
              error: {
                code: outOfScope.length ? 'PATH_SCOPE_VIOLATION' : 'PATCH_FAILED_ROLLED_BACK',
                message: outOfScope.length
                  ? `changed paths outside declared scope; rolled back: ${outOfScope.join(', ')}`
                  : `patch failed; workspace restored to savepoint`,
                outOfScope,
                cleanupRequired: false,
                reconciliationRequired: false,
                repositoryChanged: false,
              },
              applied,
            };
          } else {
            policyDecision = 'path_scope_violation_cleanup_required';
            repositoryChanged = true;
            changedPaths = [...new Set([...outOfScope, ...restored.failedPaths, ...verified.residual])];
            resultPayload = {
              error: {
                code: 'PATH_SCOPE_VIOLATION_CLEANUP_REQUIRED',
                message: `changed paths; rollback incomplete: ${changedPaths.join(', ')}`,
                outOfScope,
                cleanupRequired: true,
                reconciliationRequired: true,
                repositoryChanged: true,
              },
              applied,
            };
          }
        } else {
          discardWorkspaceSavepoint(savepoint);
          resultPayload = { applied, changedPaths, fencingToken };
        }
      } else if (operation === 'stage_paths' || operation === 'git_stage_paths') {
        helpers?.assert();
        const paths = stringList(request.input.paths) ?? [];
        if (paths.length === 0) throw new Error('STAGE_PATHS_REQUIRED: paths must be non-empty');
        resultPayload = await trace.measure('executionMs', async () => {
          const git = await runBoundedGit(root, ['add', '--', ...paths], {
            timeoutMs,
            maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
            signal,
          });
          if (git.cancelled) throw new Error('CANCELLED: git add cancelled');
          if (git.timedOut) throw new Error('GIT_STAGE_TIMEOUT: git add timed out');
          if (!git.ok) throw new Error(`GIT_STAGE_FAILED: ${git.stderr || `exit ${git.exitCode}`}`);
          return {
            ok: true,
            exitCode: git.exitCode,
            timedOut: false,
            cancelled: false,
            stdout: git.stdout,
            stderr: git.stderr,
            fencingToken,
            changedPaths: paths,
            paths,
          };
        });
        changedPaths = paths;
        repositoryChanged = true;
        ok = true;
        outcome = 'succeeded';
      } else if (operation === 'commit_paths' || operation === 'git_commit_paths' || operation === 'repository_git_commit') {
        helpers?.assert();
        resultPayload = await trace.measure('executionMs', async () => {
          const commit = repositoryGitCommit(ctx.controllerHome, ctx.repository, {
            message: request.input.message,
            paths: request.input.paths,
            allowEmpty: request.input.allow_empty,
          });
          return { commit, fencingToken, baseHead } as Record<string, unknown>;
        });
        const commit = resultPayload.commit as { paths?: string[] } | undefined;
        changedPaths = commit?.paths ?? stringList(request.input.paths) ?? [];
        repositoryChanged = true;
      } else if (
        operation === 'run_short_command'
        || operation === 'run_focused_check'
        || operation === 'repository_command_execute'
      ) {
        const command = request.input.command as string | string[];
        const preview = await trace.measure('policyMs', async () => previewRepositoryCommandExecutionAsync(ctx.repository, {
          command,
          cwd: typeof request.input.cwd === 'string' ? request.input.cwd : undefined,
          authorization: 'confirmed_plan',
          approvalToken: typeof request.input.approval_token === 'string' ? request.input.approval_token : undefined,
          approvalRequestId: typeof request.input.approval_request_id === 'string' ? request.input.approval_request_id : undefined,
          timeoutMs,
          maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
          sessionId: ctx.sessionId,
          principalId: ctx.principalId,
          signal,
        }, ctx.controllerHome));
        const approvalToken = typeof request.input.approval_token === 'string' && request.input.approval_token.trim()
          ? request.input.approval_token.trim()
          : preview.execution.approvalToken;
        let sealed = preview;
        let reuseSnapshot: RepositoryCommandSnapshot | undefined = preview.before;
        if (!preview.executable) {
          // Second seal only when approval token was injected; reuse snapshot.
          sealed = await previewRepositoryCommandExecutionAsync(ctx.repository, {
            command,
            cwd: typeof request.input.cwd === 'string' ? request.input.cwd : undefined,
            authorization: 'confirmed_plan',
            approvalToken,
            approvalRequestId: typeof request.input.approval_request_id === 'string' ? request.input.approval_request_id : undefined,
            timeoutMs,
            maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
            sessionId: ctx.sessionId,
            principalId: ctx.principalId,
            signal,
            reuseSnapshot: preview.before,
          }, ctx.controllerHome);
          reuseSnapshot = sealed.before;
        }
        if (!sealed.executable) {
          throw Object.assign(
            new Error(sealed.execution.policyDecision === 'rejected'
              ? `COMMAND_REJECTED: ${sealed.execution.classification.reasons.join('; ')}`
              : `COMMAND_APPROVAL_REQUIRED: use Durable Work / approval_resolve`),
            { preview: sealed },
          );
        }
        authorizationDecision = String(sealed.execution.authorizationDecision?.decision
          ?? sealed.execution.authorization
          ?? (sealed.execution.classification.risk === 'readonly' ? 'readonly' : 'confirmed_plan'));
        helpers?.assert();
        const execution = await trace.measure('executionMs', async () => executeRepositoryCommandAsync(
          ctx.controllerHome,
          ctx.repository,
          {
            command,
            cwd: typeof request.input.cwd === 'string' ? request.input.cwd : undefined,
            authorization: 'confirmed_plan',
            approvalToken,
            approvalRequestId: typeof request.input.approval_request_id === 'string' ? request.input.approval_request_id : undefined,
            timeoutMs,
            maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
            sessionId: ctx.sessionId,
            principalId: ctx.principalId,
            signal,
            reuseSnapshot,
          },
        ));
        ok = execution.ok === true && execution.status === 'executed' && !execution.cancelled;
        outcome = execution.cancelled
          ? 'cancelled'
          : execution.timedOut
            ? 'timed_out'
            : ok
              ? 'succeeded'
              : 'failed';
        changedPaths = execution.changedPaths ?? [];
        repositoryChanged = execution.repositoryChanged === true;
        policyDecision = execution.policyDecision ?? 'allowed';
        resultPayload = {
          status: execution.status,
          ok: execution.ok,
          exitCode: execution.exitCode,
          timedOut: execution.timedOut,
          cancelled: execution.cancelled,
          stdout: execution.stdout,
          stderr: execution.stderr,
          repositoryChanged: execution.repositoryChanged,
          changedPaths: execution.changedPaths,
          classification: execution.classification,
        };
      } else {
        throw new Error(`FAST_OPERATION_UNSUPPORTED: ${operation}`);
      }
    } catch (error) {
      ok = false;
      outcome = signal?.aborted ? 'cancelled' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'FAST_EXECUTION_FAILED';
      resultPayload = {
        error: { code, message },
        ...((error as { preview?: unknown })?.preview ? { preview: (error as { preview: unknown }).preview } : {}),
      };
    }

    // Post-mutation fencing check when ownership helpers available.
    if (helpers) {
      try {
        helpers.assert();
      } catch (error) {
        ok = false;
        outcome = helpers.ownershipLost() ? 'cancelled' : 'failed';
        repositoryChanged = true;
        resultPayload = {
          ...resultPayload,
          error: {
            code: 'MUTATION_OWNERSHIP_LOST',
            message: error instanceof Error ? error.message : String(error),
            reconciliationRequired: true,
            repositoryChanged: true,
          },
        };
      }
    }

    return {
      ok,
      outcome,
      changedPaths,
      repositoryChanged,
      resultPayload,
      authorizationDecision: String(authorizationDecision),
      policyDecision,
    };
  };

  let bodyResult: Awaited<ReturnType<typeof runBody>>;
  let fencingToken: number | undefined;
  let baseHead: string | null | undefined;
  let processStopUnconfirmed = false;

  if (needsMutation && !request.externalMutation) {
    // Mutation lease alone serializes writers — do NOT hold repository controller lock
    // during runBody (renewExecutionLeases needs that lock for heartbeat).
    const ownership = ownershipOptionsFor(String(operation), decision, request.input);
    try {
      const gated = await withCheckoutMutationGate(
        {
          controllerHome: ctx.controllerHome,
          repoId: ctx.repository.repoId,
          checkoutId: ctx.repository.activeCheckoutId,
          repoRoot: root,
          owner,
          ttlMs: timeoutMs + 10_000,
          signal: request.signal,
          ownership,
        },
        async (gate, helpers) => {
          fencingToken = gate.fencingToken;
          baseHead = gate.baseHead;
          if (acquiredLedger) {
            heartbeatFastRequest(ctx.controllerHome, acquiredLedger, timeoutMs + 10_000);
          }
          // Align ledger heartbeat with ownership renews.
          const ledgerHeartbeat = setInterval(() => {
            if (acquiredLedger) {
              const beat = heartbeatFastRequest(ctx.controllerHome, acquiredLedger, gate.ttlMs);
              if (beat.entry) acquiredLedger = beat.entry;
            }
          }, Math.max(500, Math.floor(gate.ttlMs / 3)));
          ledgerHeartbeat.unref?.();
          try {
            return await runBody(gate.fencingToken, gate.baseHead, helpers, helpers.signal);
          } finally {
            clearInterval(ledgerHeartbeat);
          }
        },
      );
      if (!gated.ok) {
        if (ledgerEntry?.kind === 'acquired') {
          completeFastRequest(ctx.controllerHome, ledgerEntry.entry, {
            status: 'failed',
            error: mutationGateBusyMessage(gated.busy),
          });
        }
        return {
          ok: false,
          decision: emptyDecision({
            mode: 'durable',
            reasons: ['checkout_mutation_busy', gated.busy.reason],
            risk: 'workspace_write',
            effects: decision.effects,
            suggestedOperation: 'retry after durable writer finishes, or use Durable Work',
          }),
          operationSucceeded: false,
          latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
          durableSideEffects: observedSideEffects(sideEffectsBefore),
          result: {
            error: {
              code: 'MUTATION_BUSY',
              message: mutationGateBusyMessage(gated.busy),
              blockers: gated.busy.blockers,
            },
          },
          escalation: {
            reason: mutationGateBusyMessage(gated.busy),
            suggestedOperation: 'wait or use Durable Work',
          },
        };
      }
      bodyResult = gated.value;
      fencingToken = gated.gate.fencingToken;
      baseHead = gated.gate.baseHead;
      processStopUnconfirmed = gated.processStopUnconfirmed === true;
    } catch (error) {
      if (ledgerEntry?.kind === 'acquired') {
        completeFastRequest(ctx.controllerHome, ledgerEntry.entry, {
          status: 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        ok: false,
        decision,
        operationSucceeded: false,
        outcome: 'unknown',
        repositoryChanged: true,
        reconciliationRequired: true,
        processStopUnconfirmed: true,
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: observedSideEffects(sideEffectsBefore),
        ledgerPersisted: true,
        result: {
          error: {
            code: 'MUTATION_OUTCOME_UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
            outcome: 'unknown',
            repositoryChanged: true,
            reconciliationRequired: true,
          },
        },
      };
    }
  } else if (needsMutation && request.externalMutation) {
    const helpers = request.externalHelpers;
    fencingToken = request.externalGate?.fencingToken ?? helpers?.getGate().fencingToken;
    baseHead = request.externalGate?.baseHead ?? helpers?.getGate().baseHead;
    bodyResult = await runBody(
      fencingToken,
      baseHead,
      helpers,
      helpers?.signal ?? request.signal,
    );
  } else {
    bodyResult = await runBody(undefined, undefined, undefined, request.signal);
  }

  const finishedAt = new Date().toISOString();
  let receipt: FastExecutionReceipt | undefined;
  let receiptPersisted: boolean | undefined;
  let receiptWarning: string | undefined;
  let ledgerPersisted: boolean | undefined;
  let ledgerWarning: string | undefined;

  // Snapshot latency before receipt so persisted duration is complete for op time.
  const preReceiptLatency = trace.snapshot(false);
  const durationForReceipt = preReceiptLatency.totalMs;

  if (receiptMode === 'standalone') {
    const receiptStarted = performance.now();
    const written = writeFastReceipt(ctx.controllerHome, {
      repoId: ctx.repository.repoId,
      checkoutId: ctx.repository.activeCheckoutId,
      operation: String(operation),
      startedAt,
      finishedAt,
      durationMs: durationForReceipt,
      outcome: bodyResult.outcome,
      changedPaths: bodyResult.changedPaths,
      repositoryChanged: bodyResult.repositoryChanged,
      authorizationDecision: bodyResult.authorizationDecision,
      policyDecision: bodyResult.policyDecision,
      outputSummary: summaryFrom(bodyResult.resultPayload),
      reasons: decision.reasons,
      requestId,
      fencingToken,
      baseHead,
      inputHash,
    });
    receipt = written.receipt;
    receiptPersisted = written.persisted;
    receiptWarning = written.warning;
    trace.add('receiptMs', performance.now() - receiptStarted);
  }

  const latency = trace.snapshot(ctx.includeLatencyBreakdown === true);
  if (receipt) {
    receipt.durationMs = durationForReceipt;
    if (ctx.includeLatencyBreakdown === true) {
      receipt.latency = {
        ...latency,
        totalMs: durationForReceipt + (latency.receiptMs || 0),
      };
    }
  }

  const resultError = bodyResult.resultPayload.error as {
    message?: string;
    reconciliationRequired?: boolean;
    cleanupRequired?: boolean;
    repositoryChanged?: boolean;
  } | undefined;
  const outcomeUnknown = processStopUnconfirmed
    || bodyResult.outcome === 'cancelled' && bodyResult.repositoryChanged
    || resultError?.reconciliationRequired === true && !bodyResult.ok && bodyResult.repositoryChanged;

  if (ledgerEntry?.kind === 'acquired' || acquiredLedger) {
    const expected = acquiredLedger ?? ledgerEntry!.entry;
    const ledgerStatus = bodyResult.ok
      ? 'succeeded' as const
      : outcomeUnknown || processStopUnconfirmed
        ? 'unknown' as const
        : 'failed' as const;
    const completed = completeFastRequest(ctx.controllerHome, expected, {
      status: ledgerStatus,
      resultSummary: summaryFrom(bodyResult.resultPayload, 1_024),
      error: bodyResult.ok
        ? undefined
        : resultError?.message,
      receiptExecutionId: receipt?.executionId,
    });
    ledgerPersisted = completed.ok;
    ledgerWarning = completed.warning;
  }

  const cleanupRequired = resultError?.cleanupRequired === true;
  const reconciliationRequired = resultError?.reconciliationRequired === true
    || processStopUnconfirmed
    || outcomeUnknown;

  // Mutation success is independent of receipt/ledger persistence failures.
  return {
    ok: bodyResult.ok && !processStopUnconfirmed,
    decision,
    receipt,
    receiptPersisted,
    receiptWarning,
    ledgerPersisted,
    ledgerWarning,
    operationSucceeded: bodyResult.ok,
    changedPaths: bodyResult.changedPaths,
    repositoryChanged: Boolean(bodyResult.repositoryChanged) || processStopUnconfirmed,
    outcome: processStopUnconfirmed ? 'unknown' : bodyResult.outcome,
    result: bodyResult.resultPayload,
    latency,
    durableSideEffects: observedSideEffects(sideEffectsBefore),
    reconciliationRequired: reconciliationRequired || undefined,
    cleanupRequired: cleanupRequired || undefined,
    processStopUnconfirmed: processStopUnconfirmed || undefined,
  };
}
