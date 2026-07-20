import { spawn } from 'child_process';
import { getMcpPolicy } from '../../../cli/mcp/policy';
import { applySafePatch } from '../../../cli/repositories/safe-patch';
import {
  repositoryGitCommit,
  repositoryGitDiff,
  repositoryGitStatus,
} from '../../../cli/repositories/structured-git';
import { withControllerLock } from '../../../cli/repositories/locks';
import {
  executeRepositoryCommand,
  previewRepositoryCommandExecution,
} from '../../../cli/repositories/command-executor';
import { readRepositoryRange, searchRepository } from '../../../cli/repository/inspector';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { capProcessOutput, redactProcessOutput } from '../../../effects/process-runner';
import { routeExecution } from './execution-router';
import { LatencyTrace } from './latency-trace';
import { recordFastReceiptMetric, writeFastReceipt } from './fast-receipt';
import {
  FAST_PATH_DEFAULT_TIMEOUT_MS,
  FAST_PATH_MAX_OUTPUT_BYTES,
  FAST_PATH_MAX_TIMEOUT_MS,
  type ExecutionDecision,
  type FastExecutionReceipt,
  type FastOperationKind,
  type LatencyBreakdown,
} from './types';

export interface FastExecutorContext {
  controllerHome: string;
  repository: RepositoryRecord;
  /** When true, attach full latency breakdown. */
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
}

export interface FastExecuteResult {
  ok: boolean;
  decision: ExecutionDecision;
  receipt?: FastExecutionReceipt;
  result?: Record<string, unknown>;
  latency: LatencyBreakdown;
  escalation?: { reason: string; suggestedOperation: string };
  /** Always zero on Fast Path — used by benchmarks. */
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

/**
 * Execute one Fast Path operation without ExecutionJob / Local Job / Worker / Campaign.
 * Write ops take a short checkout-level lock only.
 */
export async function executeFast(
  ctx: FastExecutorContext,
  request: FastExecuteInput,
): Promise<FastExecuteResult> {
  const startedAt = new Date().toISOString();
  const trace = new LatencyTrace('fast');
  const zeroSideEffects = {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };

  const decision = trace.measureSync('gatewayValidationMs', () => routeExecution({
    operation: request.operation,
    mode: request.mode ?? 'auto',
    background: request.background,
    timeoutMs: request.timeoutMs,
    command: request.input.command as string | string[] | undefined,
    paths: stringList(request.input.paths) ?? stringList(request.input.changed_paths),
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
    const latency = trace.snapshot(ctx.includeLatencyBreakdown === true);
    return {
      ok: false,
      decision,
      latency,
      durableSideEffects: zeroSideEffects,
      result: {
        error: {
          code: decision.rejectCode ?? 'FAST_REJECTED',
          message: decision.reasons.join('; '),
        },
      },
    };
  }

  if (decision.mode === 'durable') {
    const latency = trace.snapshot(ctx.includeLatencyBreakdown === true);
    return {
      ok: false,
      decision,
      latency,
      escalation: {
        reason: decision.reasons.join('; '),
        suggestedOperation: decision.suggestedOperation ?? 'Durable Work',
      },
      durableSideEffects: zeroSideEffects,
      result: {
        mode: 'durable',
        reason: decision.reasons.join('; '),
        suggestedOperation: decision.suggestedOperation,
        message: 'Fast Path declined. Open an explicit Durable Work request; partial fast steps were not executed.',
      },
    };
  }

  const operation = request.operation;
  const timeoutMs = boundedTimeout(request.timeoutMs ?? (typeof request.input.timeout_ms === 'number' ? request.input.timeout_ms : undefined));
  const root = ctx.repository.canonicalRoot;
  let outcome: FastExecuteResult['receipt'] extends FastExecutionReceipt | undefined
    ? NonNullable<FastExecuteResult['receipt']>['outcome']
    : never = 'succeeded';
  let changedPaths: string[] = [];
  let repositoryChanged = false;
  let resultPayload: Record<string, unknown> = {};
  let authorizationDecision = 'policy';
  let policyDecision = 'allowed';
  let ok = true;

  try {
    if (operation === 'read_file' || operation === 'read_file_range') {
      resultPayload = trace.measureSync('operationExecutionMs', () => {
        const path = String(request.input.path ?? '');
        const startLine = typeof request.input.start_line === 'number' ? request.input.start_line : 1;
        const endLine = typeof request.input.end_line === 'number' ? request.input.end_line : startLine + 199;
        return readRepositoryRange(root, policyFor(root), path, startLine, endLine, {
          sessionId: ctx.sessionId ?? 'fast',
          repoId: ctx.repository.repoId,
          checkoutId: ctx.repository.activeCheckoutId,
        }) as unknown as Record<string, unknown>;
      });
    } else if (operation === 'search' || operation === 'search_repository') {
      resultPayload = trace.measureSync('operationExecutionMs', () => searchRepository(root, policyFor(root), {
        query: String(request.input.query ?? ''),
        includeGlobs: stringList(request.input.include_globs),
        excludeGlobs: stringList(request.input.exclude_globs),
        maxResults: typeof request.input.max_results === 'number' ? request.input.max_results : 50,
        maxFiles: typeof request.input.max_files === 'number' ? request.input.max_files : 2_000,
        caseSensitive: request.input.case_sensitive === true,
        session: {
          sessionId: ctx.sessionId ?? 'fast',
          repoId: ctx.repository.repoId,
          checkoutId: ctx.repository.activeCheckoutId,
        },
      }) as unknown as Record<string, unknown>);
    } else if (operation === 'git_status' || operation === 'repository_git_status') {
      resultPayload = trace.measureSync('operationExecutionMs', () => {
        const snapshotStarted = performance.now();
        const status = repositoryGitStatus(ctx.repository);
        trace.add('repositorySnapshotMs', performance.now() - snapshotStarted);
        return { status };
      });
    } else if (operation === 'git_diff' || operation === 'repository_git_diff' || operation === 'git_diff_paths') {
      resultPayload = trace.measureSync('operationExecutionMs', () => {
        const snapshotStarted = performance.now();
        const diff = repositoryGitDiff(ctx.repository, {
          staged: request.input.staged,
          paths: request.input.paths,
          maxBytes: request.input.max_bytes ?? FAST_PATH_MAX_OUTPUT_BYTES,
        });
        trace.add('repositorySnapshotMs', performance.now() - snapshotStarted);
        return { diff };
      });
    } else if (operation === 'apply_patch' || operation === 'repository_safe_patch_apply' || operation === 'apply_edit_operations') {
      const applied = await trace.measure('operationExecutionMs', async () => withControllerLock(
        ctx.controllerHome,
        { scope: 'repository', repoId: ctx.repository.repoId, resource: 'fast-write' },
        'thin-harness:fast-apply-patch',
        () => applySafePatch(ctx.repository, {
          sessionId: request.input.session_id,
          purpose: request.input.purpose ?? 'fast-path-patch',
          operations: request.input.operations,
          chunkSize: request.input.chunk_size,
          expectedRevision: request.input.expected_revision,
          allowedPaths: request.allowedPaths ?? stringList(request.input.allowed_paths),
          continueOnError: false,
          refreshFingerprints: request.input.refresh_fingerprints !== false,
          recoverStaleSession: request.input.recover_stale_session !== false,
        }),
        15_000,
      ));
      changedPaths = [...new Set((applied.appliedChunks ?? []).flatMap((chunk) => chunk.paths ?? []))];
      repositoryChanged = changedPaths.length > 0;
      ok = applied.status === 'applied';
      outcome = ok ? 'succeeded' : 'failed';
      policyDecision = ok ? 'allowed' : 'failed';
      // Enforce declared path scope after apply
      const allowed = request.allowedPaths ?? stringList(request.input.allowed_paths);
      if (ok && allowed?.length) {
        const outOfScope = changedPaths.filter((path) => !allowed.some((pattern) => {
          const normalized = path.replace(/^\.\//, '');
          const p = pattern.replace(/^\.\//, '');
          if (p.endsWith('/**')) return normalized === p.slice(0, -3) || normalized.startsWith(`${p.slice(0, -3)}/`);
          return normalized === p || normalized.startsWith(`${p}/`);
        }));
        if (outOfScope.length > 0) {
          ok = false;
          outcome = 'failed';
          policyDecision = 'path_scope_violation';
          resultPayload = {
            error: {
              code: 'PATH_SCOPE_VIOLATION',
              message: `changed paths outside declared scope: ${outOfScope.join(', ')}`,
              outOfScope,
            },
            applied,
          };
        } else {
          resultPayload = { applied, changedPaths };
        }
      } else {
        resultPayload = { applied, changedPaths };
      }
    } else if (operation === 'stage_paths' || operation === 'git_stage_paths') {
      const paths = stringList(request.input.paths) ?? [];
      if (paths.length === 0) throw new Error('STAGE_PATHS_REQUIRED: paths must be non-empty');
      resultPayload = await trace.measure('operationExecutionMs', async () => withControllerLock(
        ctx.controllerHome,
        { scope: 'repository', repoId: ctx.repository.repoId, resource: 'fast-write' },
        'thin-harness:fast-stage',
        () => {
          const args = ['-C', root, 'add', '--', ...paths];
          return runBoundedGit(args, timeoutMs);
        },
        10_000,
      ));
      changedPaths = paths;
      repositoryChanged = true;
      ok = resultPayload.ok === true;
      outcome = ok ? 'succeeded' : 'failed';
    } else if (operation === 'commit_paths' || operation === 'git_commit_paths' || operation === 'repository_git_commit') {
      resultPayload = await trace.measure('operationExecutionMs', async () => withControllerLock(
        ctx.controllerHome,
        { scope: 'repository', repoId: ctx.repository.repoId, resource: 'fast-write' },
        'thin-harness:fast-commit',
        () => {
          const commit = repositoryGitCommit(ctx.controllerHome, ctx.repository, {
            message: request.input.message,
            paths: request.input.paths,
            allowEmpty: request.input.allow_empty,
          });
          return { commit } as Record<string, unknown>;
        },
        15_000,
      ));
      const commit = resultPayload.commit as { paths?: string[] } | undefined;
      changedPaths = commit?.paths ?? stringList(request.input.paths) ?? [];
      repositoryChanged = true;
    } else if (
      operation === 'run_short_command'
      || operation === 'run_focused_check'
      || operation === 'repository_command_execute'
    ) {
      const command = request.input.command as string | string[];
      const preview = await trace.measure('authorizationMs', async () => previewRepositoryCommandExecution(ctx.repository, {
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
      // Focused checks / readonly: seal with the preview token when still approval-gated.
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
      authorizationDecision = sealed.execution.authorizationDecision?.decision
        ?? sealed.execution.authorization
        ?? (sealed.execution.classification.risk === 'readonly' ? 'readonly' : 'confirmed_plan');
      const execution = await trace.measure('operationExecutionMs', async () => executeRepositoryCommand(
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
    outcome = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'FAST_EXECUTION_FAILED';
    resultPayload = {
      error: { code, message },
      ...((error as { preview?: unknown })?.preview ? { preview: (error as { preview: unknown }).preview } : {}),
    };
  }

  const finishedAt = new Date().toISOString();
  const latency = trace.snapshot(ctx.includeLatencyBreakdown === true);
  const receipt = recordFastReceiptMetric(writeFastReceipt(ctx.controllerHome, {
    repoId: ctx.repository.repoId,
    checkoutId: ctx.repository.activeCheckoutId,
    operation: String(operation),
    startedAt,
    finishedAt,
    durationMs: latency.totalMs,
    outcome,
    changedPaths,
    repositoryChanged,
    authorizationDecision: String(authorizationDecision),
    policyDecision,
    outputSummary: summaryFrom(resultPayload),
    latency: ctx.includeLatencyBreakdown === true ? latency : undefined,
    reasons: decision.reasons,
  }));

  return {
    ok,
    decision,
    receipt,
    result: resultPayload,
    latency,
    durableSideEffects: zeroSideEffects,
  };
}

function runBoundedGit(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        ok: false,
        timedOut: true,
        stdout: capProcessOutput(redactProcessOutput(stdout), FAST_PATH_MAX_OUTPUT_BYTES),
        stderr: capProcessOutput(redactProcessOutput(stderr), FAST_PATH_MAX_OUTPUT_BYTES),
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code ?? 1,
        timedOut: false,
        stdout: capProcessOutput(redactProcessOutput(stdout), FAST_PATH_MAX_OUTPUT_BYTES),
        stderr: capProcessOutput(redactProcessOutput(stderr), FAST_PATH_MAX_OUTPUT_BYTES),
      });
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: redactProcessOutput(error.message),
      });
    });
  });
}
