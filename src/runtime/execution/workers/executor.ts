import { bindRepositoryEntities } from '../../../cli/repositories/entity-migration';
import { getRepository, repositorySummary, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { callRepositoryTool } from '../../../cli/mcp/repository-tools';
import { callMcpTool, type CallToolResult, type McpToolContext } from '../../../cli/mcp/tools';
import { runtimePolicy } from '../../../cli/mcp/multi-repository';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { evaluateReleaseGate } from '../../release/release-gate';
import { executeLocalBridgeJobInline, getLocalBridgeJob } from '../../../cli/local-bridge/job-store';
import { settleScheduledExecution } from '../../workflow/schedules/settlement';
import type { ExecutionJob, ExecutionJobOutcome } from '../jobs/types';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import { recordCandidateFinding, updateCandidateFinding } from '../../workflow/findings/store';
import { writeControllerContextProjection } from '../../projections/controller-context';
import { triggerWorkspaceAgent } from '../../workflow/campaigns/workspace-agent';
import { executeAssistantPluginAction } from '../../plugins/store';
import { isAssistantPluginError } from '../../plugins/errors';


async function settleLegacyLocalJob(repoRoot: string, jobId: string, timeoutMs = 15 * 60_000) {
  const started = Date.now();
  let current = getLocalBridgeJob(repoRoot, jobId);
  const projectedExecutionPending = current.result
    && typeof current.result.executionJobId === 'string'
    && (current.status === 'dispatched' || (current.status === 'running' && current.ownerPid === undefined));
  if (current.status === 'approved' || projectedExecutionPending) {
    current = executeLocalBridgeJobInline(repoRoot, jobId);
  }
  while (['approved', 'dispatched', 'running'].includes(current.status)) {
    if (Date.now() - started >= timeoutMs) throw new Error(`LEGACY_JOB_TIMEOUT: ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = getLocalBridgeJob(repoRoot, jobId);
  }
  return current;
}

function legacyJobIdFromResult(record: Record<string, unknown>): string | undefined {
  if (typeof record.jobId === 'string') return record.jobId;
  const nested = record.job;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).jobId === 'string') {
    return String((nested as Record<string, unknown>).jobId);
  }
  return undefined;
}

export interface WorkerExecutionResult {
  ok: boolean;
  result?: Record<string, unknown>;
  outcome?: ExecutionJobOutcome;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
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

export async function executeExecutionJob(controllerHome: string, job: ExecutionJob): Promise<WorkerExecutionResult> {
  try {
    if (job.origin.surface === 'schedule' || (job.origin.surface === 'system' && job.payload.portfolioWorkflowId)) {
      assertAutomatedOperationAllowed(job.payload.operation, job.payload.arguments ?? {});
    }
    if (job.repoId === '__controller__' && job.payload.target !== 'repository-tool') {
      throw new Error('CONTROLLER_JOB_INVALID: controller-scoped jobs must target repository tools');
    }
    if (job.payload.target === 'repository-tool') {
      const output = await callRepositoryTool(controllerHome, job.payload.operation, job.payload.arguments ?? {});
      if (!output) throw new Error(`UNKNOWN_REPOSITORY_TOOL: ${job.payload.operation}`);
      const record = toolResultRecord(output);
      return output.isError
        ? { ok: false, error: { code: 'REPOSITORY_TOOL_FAILED', message: JSON.stringify(record), retryable: false }, repoRoot: controllerHome }
        : { ok: true, result: record, repoRoot: controllerHome };
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
      const localJob = await settleLegacyLocalJob(repoRoot, localJobId, typeof job.payload.timeoutMs === 'number' ? job.payload.timeoutMs : undefined);
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
      return { ok: true, result: pluginResult, repoRoot };
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
        const localJob = await settleLegacyLocalJob(repoRoot, legacyJobId, typeof job.payload.timeoutMs === 'number' ? job.payload.timeoutMs : undefined);
        record = { ...record, localJob };
        outcome = localJob.outcome;
        if (localJob.status !== 'succeeded') {
          return { ok: false, error: { code: 'LEGACY_JOB_FAILED', message: localJob.error ?? `Local Job ended as ${localJob.status}`, retryable: false, details: { localJob } }, repoRoot };
        }
      } catch {
        // Not every job-shaped response belongs to the Local Bridge compatibility projection.
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
