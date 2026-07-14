import { bindRepositoryEntities } from '../../../cli/repositories/entity-migration';
import { getRepository, repositorySummary, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { callRepositoryTool } from '../../../cli/mcp/repository-tools';
import { callMcpTool, type CallToolResult, type McpToolContext } from '../../../cli/mcp/tools';
import { runtimePolicy } from '../../../cli/mcp/multi-repository';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { evaluateReleaseGate } from '../../release/release-gate';
import { executeLocalBridgeJobInline, getLocalBridgeJob } from '../../../cli/local-bridge/job-store';
import type { LocalBridgeJob } from '../../../cli/local-bridge/types';
import { settleScheduledExecution } from '../../workflow/schedules/settlement';
import type { ExecutionJob, ExecutionJobOutcome } from '../jobs/types';
import {
  buildDelegatedExecutionResult,
  childReferenceFromUnknown,
  hasDurableChildReference,
  isAgentDelegationLocalAction,
  isAgentDelegationOperation,
  mergeChildReferences,
  type ExecutionChildReference,
} from '../jobs/child-reference';
import { markOperationDelegated } from '../jobs/receipt-store';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import { recordCandidateFinding, updateCandidateFinding } from '../../workflow/findings/store';
import { writeControllerContextProjection } from '../../projections/controller-context';
import { triggerWorkspaceAgent } from '../../workflow/campaigns/workspace-agent';
import { executeAssistantPluginAction } from '../../plugins/store';
import { CONTROLLER_SCOPE_REPO_ID, controllerSystemRoot, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { writeExecutionArtifact } from '../../evidence/artifact-store';
import { existsSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import { isAssistantPluginError } from '../../plugins/errors';

function childReferenceFromLocalJob(
  localJob: LocalBridgeJob,
  requestId?: string,
): ExecutionChildReference | undefined {
  const fromResult = childReferenceFromUnknown(localJob.result);
  return mergeChildReferences(fromResult, {
    localJobId: localJob.jobId,
    runId: localJob.runId,
    issueId: localJob.issueId,
    taskId: localJob.taskId,
    requestId,
    delegatedAt: new Date().toISOString(),
  });
}

/**
 * Accept a Local Job that hands off to an Agent Run. Parent Execution Jobs only
 * need a durable child reference; they must not hold leases across the full Run.
 */
function acceptLegacyAgentLocalJob(repoRoot: string, jobId: string): LocalBridgeJob {
  let current = getLocalBridgeJob(repoRoot, jobId);
  const projectedExecutionPending = current.result
    && typeof current.result.executionJobId === 'string'
    && (current.status === 'dispatched' || (current.status === 'running' && current.ownerPid === undefined));
  if (current.status === 'approved' || projectedExecutionPending) {
    current = executeLocalBridgeJobInline(repoRoot, jobId);
  }
  // One refresh so projection from the linked Agent Run is current.
  return getLocalBridgeJob(repoRoot, jobId);
}

async function settleLegacyLocalJob(repoRoot: string, jobId: string, timeoutMs = 15 * 60_000) {
  const started = Date.now();
  const boundedTimeoutMs = Math.max(1_000, Math.trunc(timeoutMs));
  let current = getLocalBridgeJob(repoRoot, jobId);
  const projectedExecutionPending = current.result
    && typeof current.result.executionJobId === 'string'
    && (current.status === 'dispatched' || (current.status === 'running' && current.ownerPid === undefined));
  if (current.status === 'approved' || projectedExecutionPending) {
    current = executeLocalBridgeJobInline(repoRoot, jobId);
  }
  while (['approved', 'dispatched', 'running'].includes(current.status)) {
    if (Date.now() - started >= boundedTimeoutMs) throw new Error(`LEGACY_JOB_TIMEOUT: ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = getLocalBridgeJob(repoRoot, jobId);
  }
  return current;
}

function shouldDelegateAgentLocalJob(job: ExecutionJob, localJob?: LocalBridgeJob): boolean {
  if (isAgentDelegationOperation(job.payload.operation)) return true;
  if (job.type === 'agent-run' || job.type === 'dispatch-task') return true;
  if (localJob && isAgentDelegationLocalAction(localJob.action)) return true;
  return false;
}

function delegatedWorkerResult(
  controllerHome: string,
  job: ExecutionJob,
  localJob: LocalBridgeJob,
  repoRoot: string,
  baseRecord: Record<string, unknown> = {},
): WorkerExecutionResult {
  const childReference = childReferenceFromLocalJob(localJob, job.requestId);
  if (!hasDurableChildReference(childReference) || !childReference) {
    // Acceptance ran but no durable child pointer exists yet. Fail closed so
    // reconciliation can retry safely when no write side-effect is proven.
    if (localJob.status === 'failed' || localJob.status === 'cancelled' || localJob.status === 'timed_out') {
      return {
        ok: false,
        result: { ...baseRecord, localJob },
        outcome: localJob.outcome,
        error: {
          code: 'LEGACY_JOB_FAILED',
          message: localJob.error ?? `Local Job ended as ${localJob.status}`,
          retryable: false,
          details: { localJob },
        },
        repoRoot,
      };
    }
    return {
      ok: false,
      result: { ...baseRecord, localJob },
      error: {
        code: 'AGENT_DELEGATION_INCOMPLETE',
        message: `Agent delegation for Local Job ${localJob.jobId} did not produce a durable child reference.`,
        retryable: true,
        details: { localJobId: localJob.jobId, status: localJob.status },
      },
      repoRoot,
    };
  }

  markOperationDelegated(
    controllerHome,
    job,
    process.pid,
    childReference,
    buildDelegatedExecutionResult({
      childReference,
      localJob: localJob as unknown as Record<string, unknown>,
      extra: baseRecord,
    }),
  );

  const awaitingApproval = approvalFromLocalJob(localJob);
  if (awaitingApproval) {
    return {
      ok: false,
      result: {
        ...baseRecord,
        ...buildDelegatedExecutionResult({
          childReference,
          localJob: localJob as unknown as Record<string, unknown>,
        }),
        approvalRequestId: awaitingApproval.approvalRequestId,
        authorization: awaitingApproval.authorization,
      },
      outcome: localJob.outcome,
      awaitingApproval,
      repoRoot,
    };
  }

  // Parent Job success means "delegation accepted", never "Task/Run finished".
  return {
    ok: true,
    result: {
      ...baseRecord,
      ...buildDelegatedExecutionResult({
        childReference,
        localJob: localJob as unknown as Record<string, unknown>,
      }),
      status: localJob.status,
    },
    outcome: {
      ...(localJob.outcome ?? {}),
      process: localJob.outcome?.process,
    },
    repoRoot,
  };
}

function settlementTimeoutMsForJob(job: ExecutionJob, record?: Record<string, unknown>): number {
  const args = job.payload.arguments ?? {};
  const candidates = [
    job.payload.timeoutMs,
    typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
    typeof record?.timeoutMs === 'number' ? record.timeoutMs : undefined,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(1_000, Math.trunc(value));
    }
  }
  if (job.deadlineAt) {
    const remaining = Date.parse(job.deadlineAt) - Date.now();
    if (Number.isFinite(remaining) && remaining > 0) return Math.max(1_000, Math.trunc(remaining));
  }
  return 15 * 60_000;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function legacyJobIdFromResult(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record.jobId);
  if (direct) return direct;
  const nested = record.job;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return stringField((nested as Record<string, unknown>).jobId);
  }
  return undefined;
}

function approvalFromLocalJob(localJob: { status?: string; result?: Record<string, unknown> }) {
  if (localJob.status !== 'pending_approval') return undefined;
  const execution = localJob.result && typeof localJob.result === 'object' ? localJob.result : {};
  const decision = execution.authorizationDecision && typeof execution.authorizationDecision === 'object'
    ? execution.authorizationDecision as Record<string, unknown>
    : undefined;
  const approvalRequestId = typeof execution.approvalRequestId === 'string'
    ? execution.approvalRequestId
    : typeof decision?.approvalRequestId === 'string' ? decision.approvalRequestId : undefined;
  if (!approvalRequestId) return undefined;
  return {
    approvalRequestId,
    humanSummary: typeof decision?.humanSummary === 'string' ? decision.humanSummary : 'This operation requires confirmation before it can continue.',
    consequences: Array.isArray(decision?.consequences) ? decision.consequences.map(String) : [],
    continuation: typeof decision?.continuation === 'string'
      ? decision.continuation
      : `Resolve approvalRequestId=${approvalRequestId} to resume the same durable Job.`,
    authorization: decision ?? { decision: 'user_confirmation_required', approvalRequestId },
  };
}

export interface WorkerExecutionResult {
  ok: boolean;
  result?: Record<string, unknown>;
  outcome?: ExecutionJobOutcome;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  awaitingApproval?: {
    approvalRequestId: string;
    humanSummary: string;
    consequences: string[];
    continuation: string;
    authorization: Record<string, unknown>;
  };
  repoRoot: string;
}

function toolResultRecord(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as Record<string, unknown>;
  }
  return { content: result.content };
}

function errorCode(message: string): string {
  const index = message.indexOf(':');
  return index > 0 ? message.slice(0, index) : 'WORKER_EXECUTION_FAILED';
}

function materializePluginArtifacts(
  controllerHome: string,
  job: ExecutionJob,
  pluginResult: Record<string, unknown>,
): Record<string, unknown> {
  const resultValue = pluginResult.result;
  if (!resultValue || typeof resultValue !== 'object' || Array.isArray(resultValue)) return pluginResult;
  const resultRecord = resultValue as Record<string, unknown>;
  const candidates = Array.isArray(resultRecord.artifactCandidates) ? resultRecord.artifactCandidates : [];
  if (candidates.length === 0) return pluginResult;
  const allowedRoot = repositoryControllerRoot(controllerHome, job.repoId);
  const artifacts = candidates.slice(0, 10).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const record = candidate as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    if (!path) return [];
    const resolved = resolve(path);
    if (!existsSync(resolved)) return [];
    const rel = relative(allowedRoot, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [];
    const artifact = writeExecutionArtifact(controllerHome, job, 'evidence', {
      artifactType: typeof record.kind === 'string' ? record.kind : 'plugin_artifact',
      mediaType: typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
      path: resolved,
      boundedToControllerStorage: true,
    });
    return [{ artifactId: artifact.artifactId, kind: record.kind, mediaType: record.mediaType }];
  });
  return {
    ...pluginResult,
    result: { ...resultRecord, artifactCandidates: undefined, artifacts },
  };
}

export async function executeExecutionJob(controllerHome: string, job: ExecutionJob): Promise<WorkerExecutionResult> {
  try {
    if (job.origin.surface === 'schedule' || (job.origin.surface === 'system' && job.payload.portfolioWorkflowId)) {
      assertAutomatedOperationAllowed(job.payload.operation, job.payload.arguments ?? {});
    }
    if (
      job.repoId === CONTROLLER_SCOPE_REPO_ID
      && job.payload.target === 'runtime'
      && job.payload.operation === 'plugin_action_execute'
    ) {
      const args = job.payload.arguments ?? {};
      const pluginId = String(args.pluginId ?? '').trim();
      const actionId = String(args.actionId ?? '').trim();
      const actionArguments = args.actionArguments && typeof args.actionArguments === 'object' && !Array.isArray(args.actionArguments)
        ? args.actionArguments as Record<string, unknown>
        : {};
      if (pluginId !== 'local_system') throw new Error('CONTROLLER_PLUGIN_INVALID: only local_system is controller-scoped');
      if (!actionId) throw new Error('PLUGIN_ACTION_ID_REQUIRED');
      const repoRoot = controllerSystemRoot(controllerHome);
      const pluginResult = await executeAssistantPluginAction({
        controllerHome,
        repoId: CONTROLLER_SCOPE_REPO_ID,
        repoRoot,
        pluginId,
        actionId,
        requestId: job.requestId,
        args: actionArguments,
        origin: job.origin,
        jobId: job.jobId,
      });
      return { ok: true, result: materializePluginArtifacts(controllerHome, job, pluginResult), repoRoot };
    }
    if (job.repoId === CONTROLLER_SCOPE_REPO_ID && job.payload.target !== 'repository-tool') {
      throw new Error('CONTROLLER_JOB_INVALID: controller-scoped Jobs must use a typed controller plugin or an existing controller repository-tool operation');
    }
    if (job.payload.target === 'repository-tool') {
      const output = await callRepositoryTool(controllerHome, job.payload.operation, job.payload.arguments ?? {});
      if (!output) throw new Error(`UNKNOWN_REPOSITORY_TOOL: ${job.payload.operation}`);
      let record = toolResultRecord(output);
      if (output.isError) {
        return {
          ok: false,
          error: { code: 'REPOSITORY_TOOL_FAILED', message: JSON.stringify(record), retryable: false },
          repoRoot: controllerHome,
        };
      }

      // Agent-delegation operations only accept/create the Local Job + Agent Run.
      // Non-agent Local Job handoffs (commands/checks) still settle to a terminal state.
      const legacyJobId = legacyJobIdFromResult(record);
      if (legacyJobId && job.repoId !== '__controller__') {
        try {
          const repository = selectRepositoryCheckout(
            getRepository(job.repoId, controllerHome, { includeRemoved: true }),
            job.checkoutId,
          );
          const repoRoot = repository.canonicalRoot;
          const preview = getLocalBridgeJob(repoRoot, legacyJobId);
          if (shouldDelegateAgentLocalJob(job, preview)) {
            const localJob = acceptLegacyAgentLocalJob(repoRoot, legacyJobId);
            return delegatedWorkerResult(controllerHome, job, localJob, repoRoot, record);
          }
          const localJob = await settleLegacyLocalJob(
            repoRoot,
            legacyJobId,
            settlementTimeoutMsForJob(job, record),
          );
          record = {
            ...record,
            status: localJob.status,
            localJob,
          };
          const awaitingApproval = approvalFromLocalJob(localJob);
          if (awaitingApproval) {
            return {
              ok: false,
              result: { ...record, approvalRequestId: awaitingApproval.approvalRequestId, authorization: awaitingApproval.authorization },
              outcome: localJob.outcome,
              awaitingApproval,
              repoRoot,
            };
          }
          if (localJob.status !== 'succeeded') {
            return {
              ok: false,
              result: record,
              outcome: localJob.outcome,
              error: {
                code: 'LEGACY_JOB_FAILED',
                message: localJob.error ?? `Local Job ended as ${localJob.status}`,
                retryable: false,
                details: { localJob },
              },
              repoRoot,
            };
          }
          return { ok: true, result: record, outcome: localJob.outcome, repoRoot };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('LEGACY_JOB_TIMEOUT:')) {
            return {
              ok: false,
              result: record,
              error: { code: 'LEGACY_JOB_TIMEOUT', message, retryable: false, details: { localJobId: legacyJobId } },
              repoRoot: controllerHome,
            };
          }
          // Not every job-shaped repository-tool response is a Local Bridge job.
        }
      }

      return { ok: true, result: record, repoRoot: controllerHome };
    }

    const repository = selectRepositoryCheckout(
      getRepository(job.repoId, controllerHome, { includeRemoved: true }),
      job.checkoutId,
    );
    const repoRoot = repository.canonicalRoot;
    if (job.payload.target === 'workspace-agent') {
      const args = job.payload.arguments ?? {};
      const output = await triggerWorkspaceAgent({
        agentId: String(args.agentId ?? args.agent_id ?? ''),
        input: String(args.input ?? ''),
        conversationKey: typeof args.conversationKey === 'string'
          ? args.conversationKey
          : typeof args.conversation_key === 'string' ? args.conversation_key : undefined,
        idempotencyKey: typeof args.idempotencyKey === 'string'
          ? args.idempotencyKey
          : typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        timeoutMs: typeof args.timeoutMs === 'number'
          ? args.timeoutMs
          : typeof args.timeout_ms === 'number' ? args.timeout_ms : job.payload.timeoutMs,
      });
      return { ok: true, result: { workspaceAgent: output }, repoRoot };
    }

    const runtimeStorage = ensureRepositoryRuntimeStorage(repository, controllerHome);
    if (!runtimeStorage.readyForExecution) {
      throw new Error(`RUNTIME_STORAGE_NOT_READY: ${runtimeStorage.warnings.join('; ') || repository.activeCheckoutId}`);
    }
    bindRepositoryEntities(repository);

    if (job.payload.target === 'runtime' && job.payload.operation === 'legacy-local-job') {
      const localJobId = String(job.payload.arguments?.localJobId ?? '').trim();
      if (!localJobId) throw new Error('LEGACY_JOB_ID_REQUIRED');
      const preview = getLocalBridgeJob(repoRoot, localJobId);
      if (shouldDelegateAgentLocalJob(job, preview)) {
        const localJob = acceptLegacyAgentLocalJob(repoRoot, localJobId);
        return delegatedWorkerResult(controllerHome, job, localJob, repoRoot);
      }
      const localJob = await settleLegacyLocalJob(
        repoRoot,
        localJobId,
        settlementTimeoutMsForJob(job),
      );
      const awaitingApproval = approvalFromLocalJob(localJob);
      if (awaitingApproval) {
        return { ok: false, result: { localJob, approvalRequestId: awaitingApproval.approvalRequestId, authorization: awaitingApproval.authorization }, outcome: localJob.outcome, awaitingApproval, repoRoot };
      }
      return localJob.status === 'succeeded'
        ? { ok: true, result: { localJob }, outcome: localJob.outcome, repoRoot }
        : { ok: false, outcome: localJob.outcome, error: { code: 'LEGACY_JOB_FAILED', message: localJob.error ?? `Local Job ended as ${localJob.status}`, retryable: false, details: { localJob } }, repoRoot };
    }

    if (job.payload.target === 'runtime' && job.payload.operation === 'plugin_action_execute') {
      const args = job.payload.arguments ?? {};
      const pluginId = String(args.pluginId ?? '').trim();
      const actionId = String(args.actionId ?? '').trim();
      const actionArguments = args.actionArguments && typeof args.actionArguments === 'object' && !Array.isArray(args.actionArguments)
        ? args.actionArguments as Record<string, unknown>
        : {};
      if (!pluginId) throw new Error('PLUGIN_ID_REQUIRED');
      if (!actionId) throw new Error('PLUGIN_ACTION_ID_REQUIRED');
      const pluginResult = await executeAssistantPluginAction({
        controllerHome,
        repoId: job.repoId,
        repoRoot,
        pluginId,
        actionId,
        requestId: job.requestId,
        args: actionArguments,
        origin: job.origin,
        jobId: job.jobId,
      });
      return { ok: true, result: materializePluginArtifacts(controllerHome, job, pluginResult), repoRoot };
    }

    if (job.type === 'release-gate') {
      const gate = evaluateReleaseGate(controllerHome, repoRoot, job);
      return gate.releaseReady
        ? { ok: true, result: { releaseReady: true, gate }, repoRoot }
        : { ok: false, error: { code: 'RELEASE_GATE_BLOCKED', message: 'Release gate has blockers.', retryable: false, details: { gate } }, repoRoot };
    }

    if (job.payload.operation === 'record_candidate_finding') {
      const args = job.payload.arguments ?? {};
      const finding = recordCandidateFinding(controllerHome, {
        repoId: job.repoId,
        requestId: job.requestId,
        semanticKey: String(args.semantic_key ?? args.semanticKey ?? '').trim(),
        title: String(args.title ?? '').trim(),
        summary: typeof args.summary === 'string' ? args.summary : undefined,
        severity: ['low', 'medium', 'high', 'critical'].includes(String(args.severity))
          ? String(args.severity) as 'low' | 'medium' | 'high' | 'critical'
          : 'medium',
        evidence: {
          source: job.origin.surface,
          reference: typeof args.reference === 'string' ? args.reference : job.origin.correlationId,
          details: args.evidence && typeof args.evidence === 'object' ? args.evidence as Record<string, unknown> : undefined,
        },
      });
      return { ok: true, result: { finding }, repoRoot };
    }

    const allowedAgents = Array.isArray(job.payload.allowedAgents)
      ? job.payload.allowedAgents.filter((value): value is string => typeof value === 'string')
      : [];
    const context: McpToolContext = {
      repoRoot,
      policy: runtimePolicy(repoRoot, {
        profile: job.payload.profile ?? 'controller',
        enableChatgptBrowser: job.payload.enableChatgptBrowser === true,
        enableDevRunner: job.payload.enableDevRunner === true,
        devRunnerAgents: allowedAgents.join(','),
        devRunnerTimeoutMs: typeof job.payload.runnerTimeoutMs === 'number' ? job.payload.runnerTimeoutMs : undefined,
        devRunnerMaxTimeoutMs: typeof job.payload.runnerMaxTimeoutMs === 'number' ? job.payload.runnerMaxTimeoutMs : undefined,
      }),
      enableChatgptBrowser: job.payload.enableChatgptBrowser === true,
    };
    const result = await callMcpTool(context, job.payload.operation, job.payload.arguments ?? {});
    let record: Record<string, unknown> = {
      ...toolResultRecord(result),
      repoId: repository.repoId,
      repository: repositorySummary(repository),
      runtimeStorage,
    };
    if (job.payload.operation === 'controller_context' && !result.isError) {
      writeControllerContextProjection(controllerHome, repository.repoId, record);
    }
    let outcome: ExecutionJobOutcome | undefined;
    const legacyJobId = legacyJobIdFromResult(record);
    if (legacyJobId) {
      try {
        const preview = getLocalBridgeJob(repoRoot, legacyJobId);
        if (shouldDelegateAgentLocalJob(job, preview) || isAgentDelegationOperation(job.payload.operation)) {
          const localJob = acceptLegacyAgentLocalJob(repoRoot, legacyJobId);
          return delegatedWorkerResult(controllerHome, job, localJob, repoRoot, record);
        }
        const localJob = await settleLegacyLocalJob(
          repoRoot,
          legacyJobId,
          settlementTimeoutMsForJob(job, record),
        );
        record = { ...record, localJob };
        outcome = localJob.outcome;
        const awaitingApproval = approvalFromLocalJob(localJob);
        if (awaitingApproval) {
          return { ok: false, result: { ...record, localJob, approvalRequestId: awaitingApproval.approvalRequestId, authorization: awaitingApproval.authorization }, outcome, awaitingApproval, repoRoot };
        }
        if (localJob.status !== 'succeeded') {
          return { ok: false, error: { code: 'LEGACY_JOB_FAILED', message: localJob.error ?? `Local Job ended as ${localJob.status}`, retryable: false, details: { localJob } }, repoRoot };
        }
      } catch {
        // Not every job-shaped response belongs to the Local Bridge compatibility projection.
      }
    }

    // quick_agent_session / dispatch_task may return the Local Job inline without
    // a top-level jobId when structuredContent uses { accepted, job }.
    if (isAgentDelegationOperation(job.payload.operation) && !legacyJobId) {
      const nestedJobId = legacyJobIdFromResult(record)
        ?? (record.job && typeof record.job === 'object' ? stringField((record.job as Record<string, unknown>).jobId) : undefined);
      if (nestedJobId) {
        const localJob = acceptLegacyAgentLocalJob(repoRoot, nestedJobId);
        return delegatedWorkerResult(controllerHome, job, localJob, repoRoot, record);
      }
      const inlineChild = childReferenceFromUnknown(record) ?? childReferenceFromUnknown(record.job);
      if (hasDurableChildReference(inlineChild) && inlineChild) {
        markOperationDelegated(
          controllerHome,
          job,
          process.pid,
          { ...inlineChild, requestId: inlineChild.requestId ?? job.requestId, delegatedAt: inlineChild.delegatedAt ?? new Date().toISOString() },
          buildDelegatedExecutionResult({ childReference: inlineChild, extra: record }),
        );
        return {
          ok: true,
          result: buildDelegatedExecutionResult({ childReference: inlineChild, extra: record }),
          repoRoot,
        };
      }
    }

    if (job.type === 'scheduled-occurrence') {
      settleScheduledExecution(
        controllerHome,
        job,
        result.isError ? 'failed' : 'succeeded',
        result.isError ? 'Scheduled operation failed.' : 'Scheduled operation completed.',
      );
    }

    if (job.origin.actor === 'promote_candidate_finding' && job.origin.correlationId) {
      try {
        updateCandidateFinding(controllerHome, job.repoId, job.origin.correlationId, (current) => ({
          ...current,
          status: result.isError ? 'candidate' : 'promoted',
          promotedJobId: job.jobId,
        }), job.requestId, result.isError ? 'candidate_promotion_failed' : 'candidate_finding_promoted');
      } catch {
        // The Issue result remains authoritative even if the candidate projection needs reconciliation.
      }
    }

    if (result.isError) {
      return { ok: false, error: { code: 'MCP_TOOL_FAILED', message: JSON.stringify(record), retryable: false }, repoRoot };
    }
    return { ok: true, result: record, outcome, repoRoot };
  } catch (error) {
    if (isAssistantPluginError(error)) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        },
        repoRoot: controllerHome,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const retryable = /ECONN|EPIPE|temporar|timeout|worker|network/i.test(message);
    return { ok: false, error: { code: errorCode(message), message, retryable }, repoRoot: controllerHome };
  }
}
