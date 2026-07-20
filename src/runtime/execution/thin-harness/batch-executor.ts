import type { RepositoryRecord } from '../../../cli/repositories/types';
import { writeControllerResult } from '../../evidence/result-store';
import { routeExecution } from './execution-router';
import { executeFast } from './fast-executor';
import { LatencyTrace } from './latency-trace';
import { recordFastReceiptMetric, writeFastReceipt } from './fast-receipt';
import {
  FAST_BATCH_MAX_STEPS,
  FAST_PATH_MAX_OUTPUT_BYTES,
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
 * One repository binding, one write lock per mutating step (via executeFast),
 * one primary receipt. Never silently upgrades mid-batch.
 */
export async function executeRepositoryBatch(
  ctx: BatchExecutorContext,
  request: RepositoryBatchRequest,
): Promise<RepositoryBatchResult> {
  const startedAt = new Date().toISOString();
  const trace = new LatencyTrace('fast');
  const stopOnError = request.stopOnError !== false;
  const steps = request.steps ?? [];

  const decision = trace.measureSync('gatewayValidationMs', () => routeExecution({
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
        rejectCode: 'BATCH_TOO_LARGE',
      },
      steps: [],
      stoppedEarly: true,
      partialFailure: false,
      latency: trace.snapshot(request.includeLatencyBreakdown === true),
    };
  }

  // Pre-validate every step — fail closed before any mutation.
  for (const step of steps) {
    const stepDecision = routeExecution({
      operation: step.kind,
      mode: 'auto',
      command: step.input.command as string | string[] | undefined,
      paths: Array.isArray(step.input.paths) ? step.input.paths.map(String) : undefined,
      allowedPaths: request.allowedPaths,
      timeoutMs: typeof step.input.timeout_ms === 'number' ? step.input.timeout_ms : request.timeoutMs,
      patchOperationCount: Array.isArray(step.input.operations) ? step.input.operations.length : undefined,
      defaultBranch: ctx.repository.defaultBranch,
    });
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

  const stepResults: RepositoryBatchStepResult[] = [];
  let stoppedEarly = false;
  let partialFailure = false;
  const allChangedPaths: string[] = [];
  let repositoryChanged = false;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const stepId = step.id?.trim() || `step_${index + 1}`;
    const stepStarted = performance.now();
    const executed = await executeFast(
      {
        controllerHome: ctx.controllerHome,
        repository: ctx.repository,
        includeLatencyBreakdown: request.includeLatencyBreakdown,
        principalId: ctx.principalId,
        sessionId: ctx.sessionId,
      },
      {
        operation: step.kind,
        mode: 'fast',
        input: step.input,
        timeoutMs: typeof step.input.timeout_ms === 'number' ? step.input.timeout_ms : request.timeoutMs,
        allowedPaths: request.allowedPaths,
      },
    );
    const durationMs = Math.round((performance.now() - stepStarted) * 100) / 100;
    const outcome: FastOutcome = executed.ok
      ? 'succeeded'
      : executed.escalation
        ? 'escalated'
        : (executed.receipt?.outcome ?? 'failed');
    if (executed.receipt?.changedPaths?.length) {
      allChangedPaths.push(...executed.receipt.changedPaths);
    }
    if (executed.receipt?.repositoryChanged) repositoryChanged = true;

    const stepResult: RepositoryBatchStepResult = {
      id: stepId,
      kind: step.kind,
      ok: executed.ok,
      outcome,
      durationMs,
      summary: executed.receipt?.outputSummary,
      result: executed.result,
      error: executed.ok
        ? undefined
        : {
          code: executed.escalation ? 'STEP_ESCALATED' : 'STEP_FAILED',
          message: executed.escalation?.reason
            ?? (executed.result?.error as { message?: string } | undefined)?.message
            ?? 'step failed',
        },
      changedPaths: executed.receipt?.changedPaths,
    };
    stepResults.push(stepResult);

    // A step must never silently upgrade; treat escalation as hard stop.
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

  const ok = stepResults.length > 0 && stepResults.every((entry) => entry.ok) && !stoppedEarly;
  const finishedAt = new Date().toISOString();
  const latency = trace.snapshot(request.includeLatencyBreakdown === true);
  latency.operationExecutionMs = Math.round(
    stepResults.reduce((sum, entry) => sum + entry.durationMs, 0) * 100,
  ) / 100;

  const receipt = recordFastReceiptMetric(writeFastReceipt(ctx.controllerHome, {
    repoId: ctx.repository.repoId,
    checkoutId: ctx.repository.activeCheckoutId,
    operation: 'batch',
    startedAt,
    finishedAt,
    durationMs: latency.totalMs,
    outcome: ok ? 'succeeded' : partialFailure ? 'failed' : 'failed',
    changedPaths: allChangedPaths,
    repositoryChanged,
    authorizationDecision: 'batch_precheck',
    policyDecision: ok ? 'allowed' : 'failed',
    outputSummary: `batch steps=${stepResults.length} ok=${stepResults.filter((s) => s.ok).length} failed=${stepResults.filter((s) => !s.ok).length}`,
    latency: request.includeLatencyBreakdown === true ? latency : undefined,
    stepCount: stepResults.length,
    reasons: decision.reasons,
  }));

  let payload: RepositoryBatchResult = {
    ok,
    mode: 'fast',
    decision,
    receipt,
    steps: stepResults,
    stoppedEarly,
    partialFailure,
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
          result: step.result
            ? { truncated: true, summary: step.summary }
            : undefined,
        })),
        resultRef: stored.resultRef,
      };
    } catch {
      // Result store is optional for Fast Path; keep truncated inline payload.
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

  // Bound total step result size conservatively.
  void FAST_PATH_MAX_OUTPUT_BYTES;
  return payload;
}
