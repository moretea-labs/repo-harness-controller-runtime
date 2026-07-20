import type { RepositoryRecord } from '../../../cli/repositories/types';
import { writeControllerResult } from '../../evidence/result-store';
import { extractPatchPaths, routeExecution } from './execution-router';
import { executeFast } from './fast-executor';
import { LatencyTrace } from './latency-trace';
import { writeFastReceipt } from './fast-receipt';
import { mutationGateBusyMessage, withCheckoutMutationGate } from './mutation-gate';
import { beginFastRequest, completeFastRequest } from './request-ledger';
import { hashRequestInput } from './fast-receipt';
import {
  FAST_BATCH_MAX_STEPS,
  FAST_BATCH_MAX_TOTAL_MS,
  FAST_PATH_MAX_TIMEOUT_MS,
  type FastOutcome,
  type RepositoryBatchRequest,
  type RepositoryBatchResult,
  type RepositoryBatchStepResult,
} from './types';

export interface BatchExecutorContext {
  controllerHome: string;
  repository: RepositoryRecord;
  principalId?: string;
  sessionId?: string;
}

const MAX_INLINE_BATCH_BYTES = 64 * 1024;

/**
 * Typed multi-step batch on Fast Path.
 * One parent receipt only. Write batches hold one Mutation Ownership for the whole batch.
 */
export async function executeRepositoryBatch(
  ctx: BatchExecutorContext,
  request: RepositoryBatchRequest,
): Promise<RepositoryBatchResult> {
  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  const trace = new LatencyTrace('fast');
  const stopOnError = request.stopOnError !== false;
  const steps = request.steps ?? [];
  const requestId = request.requestId?.trim() || undefined;
  const inputHash = hashRequestInput({ steps, mode: request.mode, allowedPaths: request.allowedPaths });

  const decision = trace.measureSync('routingMs', () => routeExecution({
    operation: 'batch',
    mode: request.mode ?? 'auto',
    steps,
    timeoutMs: request.timeoutMs,
    allowedPaths: request.allowedPaths,
    defaultBranch: ctx.repository.defaultBranch,
  }));

  if (decision.mode === 'reject') {
    return {
      ok: false,
      mode: 'reject',
      decision,
      steps: [],
      stoppedEarly: true,
      partialFailure: false,
      latency: trace.snapshot(request.includeLatencyBreakdown === true),
    };
  }

  if (decision.mode === 'durable' || request.mode === 'durable') {
    return {
      ok: false,
      mode: 'durable',
      decision: decision.mode === 'durable' ? decision : {
        mode: 'durable',
        reasons: ['caller_requested_durable_batch'],
        risk: 'unknown',
        estimatedClass: 'long',
        requiresIsolation: false,
        requiresRecovery: false,
        effects: decision.effects,
        suggestedOperation: 'Durable Work batch / individual durable tools',
      },
      steps: [],
      stoppedEarly: true,
      partialFailure: false,
      latency: trace.snapshot(request.includeLatencyBreakdown === true),
      escalation: {
        reason: (decision.mode === 'durable' ? decision.reasons : ['caller_requested_durable_batch']).join('; '),
        suggestedOperation: decision.suggestedOperation ?? 'Durable Work',
      },
    };
  }

  if (steps.length > FAST_BATCH_MAX_STEPS) {
    return {
      ok: false,
      mode: 'reject',
      decision: {
        mode: 'reject',
        reasons: [`batch_exceeds_max_steps_${FAST_BATCH_MAX_STEPS}`],
        risk: 'unknown',
        estimatedClass: 'short',
        requiresIsolation: false,
        requiresRecovery: false,
        effects: decision.effects,
        rejectCode: 'BATCH_TOO_LARGE',
      },
      steps: [],
      stoppedEarly: true,
      partialFailure: false,
      latency: trace.snapshot(request.includeLatencyBreakdown === true),
    };
  }

  // Precheck each step and compute mutation effect from router, not kind name alone.
  let hasWrite = decision.effects.mutatesWorkspace || decision.effects.mutatesGitRefs;
  let hasCommit = false;
  for (const step of steps) {
    if (step.kind === 'commit_paths') hasCommit = true;
    const stepDecision = routeExecution({
      operation: step.kind,
      mode: 'auto',
      command: step.input.command as string | string[] | undefined,
      paths: Array.isArray(step.input.paths) ? step.input.paths.map(String) : undefined,
      patchPaths: extractPatchPaths(step.input.operations),
      allowedPaths: request.allowedPaths,
      timeoutMs: typeof step.input.timeout_ms === 'number' ? step.input.timeout_ms : request.timeoutMs,
      patchOperationCount: Array.isArray(step.input.operations) ? step.input.operations.length : undefined,
      defaultBranch: ctx.repository.defaultBranch,
    });
    if (stepDecision.effects.mutatesWorkspace || stepDecision.effects.mutatesGitRefs) hasWrite = true;
    if (stepDecision.mode !== 'fast') {
      return {
        ok: false,
        mode: stepDecision.mode,
        decision: {
          ...stepDecision,
          reasons: [`batch_precheck_step_${step.kind}`, ...stepDecision.reasons],
        },
        steps: [],
        stoppedEarly: true,
        partialFailure: false,
        latency: trace.snapshot(request.includeLatencyBreakdown === true),
        escalation: stepDecision.mode === 'durable'
          ? {
            reason: stepDecision.reasons.join('; '),
            suggestedOperation: stepDecision.suggestedOperation ?? 'Durable Work',
          }
          : undefined,
      };
    }
  }

  if (hasWrite && !requestId) {
    return {
      ok: false,
      mode: 'durable',
      decision: {
        mode: 'durable',
        reasons: ['write_batch_requires_request_id'],
        risk: 'workspace_write',
        estimatedClass: 'short',
        requiresIsolation: false,
        requiresRecovery: false,
        effects: decision.effects,
        suggestedOperation: 're-issue write batch with request_id',
      },
      steps: [],
      stoppedEarly: true,
      partialFailure: false,
      latency: trace.snapshot(request.includeLatencyBreakdown === true),
      escalation: {
        reason: 'write batch requires request_id for idempotency',
        suggestedOperation: 'provide request_id',
      },
    };
  }

  let ledger: ReturnType<typeof beginFastRequest> | undefined;
  if (requestId && hasWrite) {
    ledger = beginFastRequest({
      controllerHome: ctx.controllerHome,
      repoId: ctx.repository.repoId,
      checkoutId: ctx.repository.activeCheckoutId,
      requestId,
      inputHash,
      operation: 'batch',
      owner: `fast-batch:${requestId}`,
    });
    if (ledger.kind === 'replay') {
      return {
        ok: true,
        mode: 'fast',
        decision,
        steps: [],
        stoppedEarly: false,
        partialFailure: false,
        latency: trace.snapshot(request.includeLatencyBreakdown === true),
        receipt: undefined,
        resultRef: ledger.entry.resultRef,
      };
    }
    if (ledger.kind === 'in_progress') {
      return {
        ok: false,
        mode: 'busy',
        decision: {
          mode: 'durable',
          reasons: ['batch_request_in_progress'],
          risk: 'workspace_write',
          estimatedClass: 'short',
          requiresIsolation: false,
          requiresRecovery: false,
          effects: decision.effects,
        },
        steps: [],
        stoppedEarly: true,
        partialFailure: false,
        latency: trace.snapshot(request.includeLatencyBreakdown === true),
      };
    }
    if (ledger.kind === 'conflict') {
      return {
        ok: false,
        mode: 'reject',
        decision: {
          mode: 'reject',
          reasons: ['idempotency_conflict'],
          risk: 'workspace_write',
          estimatedClass: 'short',
          requiresIsolation: false,
          requiresRecovery: false,
          effects: decision.effects,
          rejectCode: 'IDEMPOTENCY_CONFLICT',
        },
        steps: [],
        stoppedEarly: true,
        partialFailure: false,
        latency: trace.snapshot(request.includeLatencyBreakdown === true),
      };
    }
  }

  const batchDeadlineMs = Math.min(
    request.timeoutMs ?? FAST_BATCH_MAX_TOTAL_MS,
    FAST_BATCH_MAX_TOTAL_MS,
  );

  const runSteps = async (
    gate?: import('./mutation-gate').CheckoutMutationGate,
    helpers?: import('./mutation-gate').MutationGateHelpers,
  ): Promise<{
    stepResults: RepositoryBatchStepResult[];
    stoppedEarly: boolean;
    partialFailure: boolean;
    allChangedPaths: string[];
    repositoryChanged: boolean;
  }> => {
    const stepResults: RepositoryBatchStepResult[] = [];
    let stoppedEarly = false;
    let partialFailure = false;
    const allChangedPaths: string[] = [];
    let repositoryChanged = false;

    for (let index = 0; index < steps.length; index += 1) {
      if (request.signal?.aborted || helpers?.signal.aborted) {
        stoppedEarly = true;
        partialFailure = true;
        break;
      }
      if (performance.now() - wallStart > batchDeadlineMs) {
        stoppedEarly = true;
        partialFailure = stepResults.length > 0;
        stepResults.push({
          id: `deadline`,
          kind: steps[index]!.kind,
          ok: false,
          outcome: 'timed_out',
          durationMs: 0,
          error: {
            code: 'BATCH_DEADLINE',
            message: `batch exceeded overall deadline ${batchDeadlineMs}ms`,
          },
        });
        break;
      }
      try {
        helpers?.assert();
      } catch (error) {
        stoppedEarly = true;
        partialFailure = true;
        stepResults.push({
          id: steps[index]!.id?.trim() || `step_${index + 1}`,
          kind: steps[index]!.kind,
          ok: false,
          outcome: 'failed',
          durationMs: 0,
          error: {
            code: 'MUTATION_OWNERSHIP_LOST',
            message: error instanceof Error ? error.message : String(error),
          },
        });
        break;
      }

      const step = steps[index]!;
      const stepId = step.id?.trim() || `step_${index + 1}`;
      const remainingMs = Math.max(100, batchDeadlineMs - (performance.now() - wallStart));
      const stepTimeout = Math.min(
        typeof step.input.timeout_ms === 'number' ? step.input.timeout_ms : request.timeoutMs ?? FAST_PATH_MAX_TIMEOUT_MS,
        remainingMs,
        FAST_PATH_MAX_TIMEOUT_MS,
      );
      const stepStarted = performance.now();
      const executed = await executeFast(
        {
          controllerHome: ctx.controllerHome,
          repository: ctx.repository,
          includeLatencyBreakdown: false,
          principalId: ctx.principalId,
          sessionId: ctx.sessionId,
        },
        {
          operation: step.kind,
          mode: 'fast',
          input: step.input,
          timeoutMs: stepTimeout,
          allowedPaths: request.allowedPaths,
          receiptMode: 'none',
          signal: helpers?.signal ?? request.signal,
          externalMutation: hasWrite,
          externalGate: gate,
          externalHelpers: helpers,
        },
      );
      try {
        helpers?.renew();
      } catch (error) {
        stoppedEarly = true;
        partialFailure = true;
        stepResults.push({
          id: stepId,
          kind: step.kind,
          ok: false,
          outcome: 'failed',
          durationMs: Math.round((performance.now() - stepStarted) * 100) / 100,
          error: {
            code: 'MUTATION_RENEW_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
          changedPaths: executed.changedPaths,
        });
        break;
      }
      const durationMs = Math.round((performance.now() - stepStarted) * 100) / 100;
      const outcome: FastOutcome = executed.ok
        ? (executed.outcome ?? 'succeeded')
        : executed.escalation
          ? 'escalated'
          : (executed.outcome ?? 'failed');
      const nestedChanged = (() => {
        if (Array.isArray(executed.changedPaths) && executed.changedPaths.length > 0) {
          return executed.changedPaths;
        }
        const applied = executed.result?.applied as { appliedChunks?: Array<{ paths?: string[] }> } | undefined;
        if (applied?.appliedChunks) return applied.appliedChunks.flatMap((chunk) => chunk.paths ?? []);
        if (Array.isArray(executed.result?.changedPaths)) return executed.result!.changedPaths as string[];
        if (Array.isArray(executed.result?.paths)) return executed.result!.paths as string[];
        return [];
      })();
      if (nestedChanged.length) allChangedPaths.push(...nestedChanged);
      if (nestedChanged.length || executed.repositoryChanged === true) repositoryChanged = true;

      const stepResult: RepositoryBatchStepResult = {
        id: stepId,
        kind: step.kind,
        ok: executed.ok,
        outcome,
        durationMs,
        summary: executed.ok ? `ok:${step.kind}` : (executed.escalation?.reason ?? 'failed'),
        result: executed.result,
        error: executed.ok
          ? undefined
          : {
            code: executed.escalation ? 'STEP_ESCALATED' : 'STEP_FAILED',
            message: executed.escalation?.reason
              ?? (executed.result?.error as { message?: string } | undefined)?.message
              ?? 'step failed',
          },
        changedPaths: nestedChanged,
      };
      stepResults.push(stepResult);

      if (executed.escalation || executed.decision.mode !== 'fast') {
        stoppedEarly = true;
        partialFailure = stepResults.some((entry) => entry.ok) && stepResults.some((entry) => !entry.ok);
        break;
      }
      if (!executed.ok) {
        partialFailure = true;
        if (stopOnError) {
          stoppedEarly = true;
          break;
        }
      }
    }

    return { stepResults, stoppedEarly, partialFailure, allChangedPaths, repositoryChanged };
  };

  let stepResults: RepositoryBatchStepResult[] = [];
  let stoppedEarly = false;
  let partialFailure = false;
  let allChangedPaths: string[] = [];
  let repositoryChanged = false;

  try {
    if (hasWrite) {
      const gated = await withCheckoutMutationGate(
        {
          controllerHome: ctx.controllerHome,
          repoId: ctx.repository.repoId,
          checkoutId: ctx.repository.activeCheckoutId,
          repoRoot: ctx.repository.canonicalRoot,
          owner: `fast-batch:${requestId ?? Date.now()}`,
          ttlMs: batchDeadlineMs + 15_000,
          signal: request.signal,
        },
        async (gate, helpers) => runSteps(gate, helpers),
      );
      if (!gated.ok) {
        if (ledger?.kind === 'acquired') {
          completeFastRequest(ctx.controllerHome, ledger.entry, {
            status: 'failed',
            error: mutationGateBusyMessage(gated.busy),
          });
        }
        return {
          ok: false,
          mode: 'busy',
          decision: {
            mode: 'durable',
            reasons: ['checkout_mutation_busy', gated.busy.reason],
            risk: 'workspace_write',
            estimatedClass: 'short',
            requiresIsolation: false,
            requiresRecovery: false,
            effects: decision.effects,
            suggestedOperation: 'retry after durable writer finishes',
          },
          steps: [],
          stoppedEarly: true,
          partialFailure: false,
          latency: trace.snapshot(request.includeLatencyBreakdown === true),
          escalation: {
            reason: mutationGateBusyMessage(gated.busy),
            suggestedOperation: 'wait or use Durable Work',
          },
        };
      }
      stepResults = gated.value.stepResults;
      stoppedEarly = gated.value.stoppedEarly;
      partialFailure = gated.value.partialFailure;
      allChangedPaths = gated.value.allChangedPaths;
      repositoryChanged = gated.value.repositoryChanged;
    } else {
      const ran = await runSteps();
      stepResults = ran.stepResults;
      stoppedEarly = ran.stoppedEarly;
      partialFailure = ran.partialFailure;
      allChangedPaths = ran.allChangedPaths;
      repositoryChanged = ran.repositoryChanged;
    }
  } catch (error) {
    if (ledger?.kind === 'acquired') {
      completeFastRequest(ctx.controllerHome, ledger.entry, {
        status: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      ok: false,
      mode: 'fast',
      decision,
      steps: stepResults,
      stoppedEarly: true,
      partialFailure: true,
      nonAtomic: true,
      latency: trace.snapshot(request.includeLatencyBreakdown === true),
      escalation: {
        reason: error instanceof Error ? error.message : String(error),
        suggestedOperation: 'inspect workspace; ledger may be unknown',
      },
    };
  }

  const ok = stepResults.length > 0 && stepResults.every((entry) => entry.ok) && !stoppedEarly;
  const finishedAt = new Date().toISOString();
  const preReceipt = trace.snapshot(false);
  const receiptStarted = performance.now();
  const written = writeFastReceipt(ctx.controllerHome, {
    repoId: ctx.repository.repoId,
    checkoutId: ctx.repository.activeCheckoutId,
    operation: 'batch',
    startedAt,
    finishedAt,
    durationMs: preReceipt.totalMs,
    outcome: ok ? 'succeeded' : 'failed',
    changedPaths: allChangedPaths,
    repositoryChanged,
    authorizationDecision: 'batch_precheck',
    policyDecision: ok ? 'allowed' : 'failed',
    outputSummary: `batch steps=${stepResults.length} ok=${stepResults.filter((s) => s.ok).length} failed=${stepResults.filter((s) => !s.ok).length}`,
    stepCount: stepResults.length,
    reasons: decision.reasons,
    requestId,
    inputHash,
  });
  trace.add('receiptMs', performance.now() - receiptStarted);
  const latency = trace.snapshot(request.includeLatencyBreakdown === true);
  latency.executionMs = Math.round(stepResults.reduce((sum, entry) => sum + entry.durationMs, 0) * 100) / 100;
  if (written.receipt) {
    written.receipt.durationMs = preReceipt.totalMs;
    if (request.includeLatencyBreakdown === true) written.receipt.latency = latency;
  }

  if (ledger?.kind === 'acquired') {
    completeFastRequest(ctx.controllerHome, ledger.entry, {
      status: ok ? 'succeeded' : 'failed',
      resultSummary: `batch ok=${ok} steps=${stepResults.length}`,
      receiptExecutionId: written.receipt?.executionId,
      error: ok ? undefined : 'batch failed or partial',
    });
  }

  let payload: RepositoryBatchResult = {
    ok,
    mode: 'fast',
    decision,
    receipt: written.receipt,
    receiptPersisted: written.persisted,
    receiptWarning: written.warning,
    steps: stepResults,
    stoppedEarly,
    partialFailure,
    nonAtomic: hasCommit || (hasWrite && partialFailure),
    latency,
  };

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INLINE_BATCH_BYTES) {
    try {
      const stored = writeControllerResult({
        controllerHome: ctx.controllerHome,
        repoId: ctx.repository.repoId,
        sessionId: ctx.sessionId ?? 'fast-batch',
        principalId: ctx.principalId ?? 'thin-harness',
        kind: 'generic',
        value: payload as unknown as Record<string, unknown>,
      });
      payload = {
        ...payload,
        steps: stepResults.map((step) => ({
          ...step,
          result: step.result ? { truncated: true, summary: step.summary } : undefined,
        })),
        resultRef: stored.resultRef,
      };
    } catch {
      payload = {
        ...payload,
        steps: stepResults.map((step) => ({
          ...step,
          result: undefined,
          summary: (step.summary ?? '').slice(0, 256),
        })),
      };
    }
  }

  return payload;
}
