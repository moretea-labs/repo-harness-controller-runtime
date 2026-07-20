import type { RepositoryRecord } from '../../../cli/repositories/types';
import { writeControllerResult } from '../../evidence/result-store';
import { extractPatchPaths, routeExecution } from './execution-router';
import { executeFast } from './fast-executor';
import { LatencyTrace } from './latency-trace';
import { writeFastReceipt } from './fast-receipt';
import { mutationGateBusyMessage, withCheckoutMutationGate } from './mutation-gate';
import {
  FAST_BATCH_MAX_STEPS,
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
const WRITE_KINDS = new Set(['apply_patch', 'stage_paths', 'commit_paths']);

/**
 * Typed multi-step batch on Fast Path.
 * One parent receipt only. Write batches hold one Checkout Mutation Gate for the whole batch.
 */
export async function executeRepositoryBatch(
  ctx: BatchExecutorContext,
  request: RepositoryBatchRequest,
): Promise<RepositoryBatchResult> {
  const startedAt = new Date().toISOString();
  const trace = new LatencyTrace('fast');
  const stopOnError = request.stopOnError !== false;
  const steps = request.steps ?? [];

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

  for (const step of steps) {
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

  const hasWrite = steps.some((step) => WRITE_KINDS.has(step.kind));
  const hasCommit = steps.some((step) => step.kind === 'commit_paths');

  const runSteps = async (): Promise<{
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
      if (request.signal?.aborted) {
        stoppedEarly = true;
        partialFailure = true;
        break;
      }
      const step = steps[index]!;
      const stepId = step.id?.trim() || `step_${index + 1}`;
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
          timeoutMs: typeof step.input.timeout_ms === 'number' ? step.input.timeout_ms : request.timeoutMs,
          allowedPaths: request.allowedPaths,
          receiptMode: 'none',
          signal: request.signal,
          externalMutation: hasWrite,
        },
      );
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

  if (hasWrite) {
    const gated = await withCheckoutMutationGate(
      {
        controllerHome: ctx.controllerHome,
        repoId: ctx.repository.repoId,
        checkoutId: ctx.repository.activeCheckoutId,
        repoRoot: ctx.repository.canonicalRoot,
        owner: `fast-batch:${request.requestId ?? Date.now()}`,
        ttlMs: (request.timeoutMs ?? 15_000) + 10_000,
      },
      async () => runSteps(),
    );
    if (!gated.ok) {
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

  const ok = stepResults.length > 0 && stepResults.every((entry) => entry.ok) && !stoppedEarly;
  const finishedAt = new Date().toISOString();
  const latency = trace.snapshot(request.includeLatencyBreakdown === true);
  latency.executionMs = Math.round(stepResults.reduce((sum, entry) => sum + entry.durationMs, 0) * 100) / 100;

  const receiptStarted = performance.now();
  const written = writeFastReceipt(ctx.controllerHome, {
    repoId: ctx.repository.repoId,
    checkoutId: ctx.repository.activeCheckoutId,
    operation: 'batch',
    startedAt,
    finishedAt,
    durationMs: latency.totalMs,
    outcome: ok ? 'succeeded' : 'failed',
    changedPaths: allChangedPaths,
    repositoryChanged,
    authorizationDecision: 'batch_precheck',
    policyDecision: ok ? 'allowed' : 'failed',
    outputSummary: `batch steps=${stepResults.length} ok=${stepResults.filter((s) => s.ok).length} failed=${stepResults.filter((s) => !s.ok).length}`,
    latency: request.includeLatencyBreakdown === true ? latency : undefined,
    stepCount: stepResults.length,
    reasons: decision.reasons,
    requestId: request.requestId,
  });
  latency.receiptMs = Math.round((performance.now() - receiptStarted) * 100) / 100;
  if (written.receipt) written.receipt.durationMs = latency.totalMs;

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
