import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getMcpPolicy } from '../../../cli/mcp/policy';
import { applySafePatch } from '../../../cli/repositories/safe-patch';
import { repositoryGitCommit } from '../../../cli/repositories/structured-git';
import { withControllerLockAsync } from '../../../cli/repositories/locks';
import {
  executeRepositoryCommandAsync,
  previewRepositoryCommandExecution,
} from '../../../cli/repositories/command-executor';
import { readRepositoryRange, searchRepository } from '../../../cli/repository/inspector';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { runBoundedGit, runBoundedProcess } from './async-process';
import { extractPatchPaths, pathAllowed, routeExecution } from './execution-router';
import { LatencyTrace } from './latency-trace';
import {
  findFastReceiptByRequestId,
  hashRequestInput,
  writeFastReceipt,
} from './fast-receipt';
import {
  mutationGateBusyMessage,
  withCheckoutMutationGate,
} from './mutation-gate';
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
  outcome?: FastOutcome;
  result?: Record<string, unknown>;
  latency: LatencyBreakdown;
  escalation?: { reason: string; suggestedOperation: string };
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
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

function zeroSideEffects() {
  return {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };
}

async function asyncGitStatus(repoRoot: string, repoId: string, checkoutId: string, timeoutMs: number, signal?: AbortSignal) {
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
      shortStatus: shortStatus.stdout,
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
  // Prefer rg when available (async child); fall back to inspector in a worker-thread-like yield.
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
    // exit 1 = no matches for rg
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
  // Fallback: yield to event loop then run inspector (still sync but after await points for lanes).
  await new Promise((resolve) => setImmediate(resolve));
  if (signal?.aborted) throw new Error('CANCELLED: search aborted');
  return searchRepository(repoRoot, policyFor(repoRoot), {
    query,
    maxResults,
    maxFiles,
  }) as unknown as Record<string, unknown>;
}

/**
 * Execute one Fast Path operation without ExecutionJob / Local Job / Worker / Campaign.
 * Blocking work runs via async spawn / yielded search; write ops use Checkout Mutation Gate.
 */
export async function executeFast(
  ctx: FastExecutorContext,
  request: FastExecuteInput,
): Promise<FastExecuteResult> {
  const startedAt = new Date().toISOString();
  const trace = new LatencyTrace('fast');
  const receiptMode = request.receiptMode ?? 'standalone';
  const requestId = request.requestId?.trim() || undefined;
  const inputHash = hashRequestInput({ operation: request.operation, input: request.input });

  if (requestId) {
    const prior = findFastReceiptByRequestId(ctx.controllerHome, ctx.repository.repoId, requestId);
    if (prior && prior.inputHash === inputHash && prior.outcome === 'succeeded') {
      return {
        ok: true,
        decision: {
          mode: 'fast',
          reasons: ['idempotent_replay'],
          risk: 'unknown',
          estimatedClass: 'short',
          requiresIsolation: false,
          requiresRecovery: false,
        },
        receipt: prior,
        receiptPersisted: true,
        operationSucceeded: true,
        result: { replayed: true, executionId: prior.executionId },
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: zeroSideEffects(),
      };
    }
  }

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
      durableSideEffects: zeroSideEffects(),
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
      durableSideEffects: zeroSideEffects(),
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
      durableSideEffects: zeroSideEffects(),
      result: { error: { code: 'CANCELLED', message: 'aborted before execution' } },
    };
  }

  const operation = request.operation;
  const timeoutMs = boundedTimeout(request.timeoutMs ?? (typeof request.input.timeout_ms === 'number' ? request.input.timeout_ms : undefined));
  const root = ctx.repository.canonicalRoot;
  const isWrite = ['apply_patch', 'repository_safe_patch_apply', 'apply_edit_operations', 'stage_paths', 'git_stage_paths', 'commit_paths', 'git_commit_paths', 'repository_git_commit'].includes(String(operation));

  const runBody = async (fencingToken?: number, baseHead?: string | null): Promise<{
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

    try {
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
          request.signal,
        ));
      } else if (operation === 'git_status' || operation === 'repository_git_status') {
        // Git status is the repository snapshot; count under snapshotMs only (no double-count).
        resultPayload = await trace.measure('snapshotMs', async () => asyncGitStatus(
          root,
          ctx.repository.repoId,
          ctx.repository.activeCheckoutId,
          timeoutMs,
          request.signal,
        ));
      } else if (operation === 'git_diff' || operation === 'repository_git_diff' || operation === 'git_diff_paths') {
        resultPayload = await trace.measure('executionMs', async () => asyncGitDiff(
          root,
          ctx.repository.repoId,
          ctx.repository.activeCheckoutId,
          request.input,
          timeoutMs,
          request.signal,
        ));
      } else if (operation === 'apply_patch' || operation === 'repository_safe_patch_apply' || operation === 'apply_edit_operations') {
        const allowed = request.allowedPaths ?? stringList(request.input.allowed_paths);
        const opPaths = extractPatchPaths(request.input.operations);
        if (allowed?.length) {
          const bad = opPaths.filter((path) => !pathAllowed(path, allowed));
          if (bad.length > 0) {
            throw new Error(`PATH_SCOPE_REJECTED: operations target paths outside allowed scope: ${bad.join(', ')}`);
          }
        }
        // Snapshot files before apply for rollback if post-check fails.
        const beforeSnapshots = new Map<string, string | null>();
        for (const path of opPaths) {
          const absolute = join(root, path);
          beforeSnapshots.set(path, existsSync(absolute) ? readFileSync(absolute, 'utf8') : null);
        }
        const applied = await trace.measure('executionMs', async () => applySafePatch(ctx.repository, {
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
        changedPaths = [...new Set((applied.appliedChunks ?? []).flatMap((chunk) => chunk.paths ?? []))];
        repositoryChanged = changedPaths.length > 0;
        ok = applied.status === 'applied';
        outcome = ok ? 'succeeded' : 'failed';
        policyDecision = ok ? 'allowed' : 'failed';
        if (ok && allowed?.length) {
          const outOfScope = changedPaths.filter((path) => !pathAllowed(path, allowed));
          if (outOfScope.length > 0) {
            // Rollback file contents from pre-apply snapshots.
            const { writeFileSync: write, unlinkSync, mkdirSync } = await import('fs');
            const { dirname } = await import('path');
            for (const [path, content] of beforeSnapshots) {
              const absolute = join(root, path);
              try {
                if (content === null) {
                  if (existsSync(absolute)) unlinkSync(absolute);
                } else {
                  mkdirSync(dirname(absolute), { recursive: true });
                  write(absolute, content, 'utf8');
                }
              } catch {
                /* best-effort rollback */
              }
            }
            ok = false;
            outcome = 'failed';
            policyDecision = 'path_scope_violation_rolled_back';
            repositoryChanged = false;
            changedPaths = [];
            resultPayload = {
              error: {
                code: 'PATH_SCOPE_VIOLATION',
                message: `changed paths outside declared scope; rolled back: ${outOfScope.join(', ')}`,
                outOfScope,
              },
            };
          } else {
            resultPayload = { applied, changedPaths, fencingToken };
          }
        } else {
          resultPayload = { applied, changedPaths, fencingToken };
        }
      } else if (operation === 'stage_paths' || operation === 'git_stage_paths') {
        const paths = stringList(request.input.paths) ?? [];
        if (paths.length === 0) throw new Error('STAGE_PATHS_REQUIRED: paths must be non-empty');
        resultPayload = await trace.measure('executionMs', async () => {
          const git = await runBoundedGit(root, ['add', '--', ...paths], {
            timeoutMs,
            maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
            signal: request.signal,
          });
          return {
            ok: git.ok,
            exitCode: git.exitCode,
            timedOut: git.timedOut,
            cancelled: git.cancelled,
            stdout: git.stdout,
            stderr: git.stderr,
            fencingToken,
            changedPaths: paths,
            paths,
          };
        });
        changedPaths = paths;
        repositoryChanged = true;
        ok = resultPayload.ok === true;
        outcome = resultPayload.cancelled ? 'cancelled' : resultPayload.timedOut ? 'timed_out' : ok ? 'succeeded' : 'failed';
      } else if (operation === 'commit_paths' || operation === 'git_commit_paths' || operation === 'repository_git_commit') {
        if (!requestId && receiptMode === 'standalone') {
          // commits without request_id are still allowed but marked non-idempotent in result
        }
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
        const preview = await trace.measure('policyMs', async () => previewRepositoryCommandExecution(ctx.repository, {
          command,
          cwd: typeof request.input.cwd === 'string' ? request.input.cwd : undefined,
          authorization: 'confirmed_plan',
          approvalToken: typeof request.input.approval_token === 'string' ? request.input.approval_token : undefined,
          approvalRequestId: typeof request.input.approval_request_id === 'string' ? request.input.approval_request_id : undefined,
          timeoutMs,
          maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
          sessionId: ctx.sessionId,
          principalId: ctx.principalId,
        }, ctx.controllerHome));
        const approvalToken = typeof request.input.approval_token === 'string' && request.input.approval_token.trim()
          ? request.input.approval_token.trim()
          : preview.execution.approvalToken;
        const sealed = preview.executable
          ? preview
          : previewRepositoryCommandExecution(ctx.repository, {
            command,
            cwd: typeof request.input.cwd === 'string' ? request.input.cwd : undefined,
            authorization: 'confirmed_plan',
            approvalToken,
            approvalRequestId: typeof request.input.approval_request_id === 'string' ? request.input.approval_request_id : undefined,
            timeoutMs,
            maxOutputBytes: FAST_PATH_MAX_OUTPUT_BYTES,
            sessionId: ctx.sessionId,
            principalId: ctx.principalId,
          }, ctx.controllerHome);
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
          },
        ));
        ok = execution.ok === true && execution.status === 'executed';
        outcome = execution.timedOut ? 'timed_out' : ok ? 'succeeded' : 'failed';
        if (request.signal?.aborted) outcome = 'cancelled';
        changedPaths = execution.changedPaths ?? [];
        repositoryChanged = execution.repositoryChanged === true;
        policyDecision = execution.policyDecision ?? 'allowed';
        resultPayload = {
          status: execution.status,
          ok: execution.ok,
          exitCode: execution.exitCode,
          timedOut: execution.timedOut,
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
      outcome = request.signal?.aborted ? 'cancelled' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'FAST_EXECUTION_FAILED';
      resultPayload = {
        error: { code, message },
        ...((error as { preview?: unknown })?.preview ? { preview: (error as { preview: unknown }).preview } : {}),
      };
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

  if (isWrite && !request.externalMutation) {
    const gated = await withCheckoutMutationGate(
      {
        controllerHome: ctx.controllerHome,
        repoId: ctx.repository.repoId,
        checkoutId: ctx.repository.activeCheckoutId,
        repoRoot: root,
        owner: `fast:${ctx.sessionId ?? 'anon'}:${operation}:${requestId ?? Date.now()}`,
        ttlMs: timeoutMs + 5_000,
      },
      async (gate) => {
        fencingToken = gate.fencingToken;
        baseHead = gate.baseHead;
        return withControllerLockAsync(
          ctx.controllerHome,
          { scope: 'repository', repoId: ctx.repository.repoId, resource: 'fast-write' },
          'thin-harness:fast-write',
          () => runBody(gate.fencingToken, gate.baseHead),
          timeoutMs + 5_000,
        );
      },
    );
    if (!gated.ok) {
      return {
        ok: false,
        decision: {
          mode: 'durable',
          reasons: ['checkout_mutation_busy', gated.busy.reason],
          risk: 'workspace_write',
          estimatedClass: 'short',
          requiresIsolation: false,
          requiresRecovery: false,
          suggestedOperation: 'retry after durable writer finishes, or use Durable Work',
        },
        operationSucceeded: false,
        latency: trace.snapshot(ctx.includeLatencyBreakdown === true),
        durableSideEffects: zeroSideEffects(),
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
  } else if (isWrite) {
    bodyResult = await withControllerLockAsync(
      ctx.controllerHome,
      { scope: 'repository', repoId: ctx.repository.repoId, resource: 'fast-write' },
      'thin-harness:fast-write-external-gate',
      () => runBody(),
      timeoutMs + 5_000,
    );
  } else {
    bodyResult = await runBody();
  }

  const finishedAt = new Date().toISOString();
  let receipt: FastExecutionReceipt | undefined;
  let receiptPersisted: boolean | undefined;
  let receiptWarning: string | undefined;

  if (receiptMode === 'standalone') {
    const receiptStarted = performance.now();
    const written = writeFastReceipt(ctx.controllerHome, {
      repoId: ctx.repository.repoId,
      checkoutId: ctx.repository.activeCheckoutId,
      operation: String(operation),
      startedAt,
      finishedAt,
      durationMs: 0,
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
    receipt.durationMs = latency.totalMs;
    if (ctx.includeLatencyBreakdown === true) receipt.latency = latency;
  }

  // Receipt persistence failure must not flip a successful mutation to failed.
  return {
    ok: bodyResult.ok,
    decision,
    receipt,
    receiptPersisted,
    receiptWarning,
    operationSucceeded: bodyResult.ok,
    changedPaths: bodyResult.changedPaths,
    repositoryChanged: bodyResult.repositoryChanged,
    outcome: bodyResult.outcome,
    result: bodyResult.resultPayload,
    latency,
    durableSideEffects: zeroSideEffects(),
  };
}
