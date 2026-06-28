import { createHash } from 'crypto';
import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import { listRepositories, repositorySummary, resolveRepositorySelection } from '../../../cli/repositories/registry';
import { cancelExecutionJob, createExecutionJob, findExecutionJob, getExecutionJob, listExecutionJobs } from '../../execution/jobs/store';
import type { ExecutionJob } from '../../execution/jobs/types';
import { readJobEvents } from '../../evidence/event-ledger';
import { readExecutionArtifact } from '../../evidence/artifact-store';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../control-plane/daemon-client';
import { readSchedulerHealthSnapshot } from '../../control-plane/global-scheduler/scheduler';
import { rebuildRepositoryProjection } from '../../projections/materialized-view';
import { createSchedule, getSchedule, getScheduleDecision, listOccurrences, listSchedules, saveSchedule } from '../../workflow/schedules/store';
import { evaluateSchedule } from '../../workflow/schedules/engine';
import { createPortfolioWorkflow, getPortfolioWorkflow, listPortfolioWorkflows } from '../../workflow/portfolio/store';
import { claimsForMcpOperation } from './resource-policy';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import { getCandidateFinding, listCandidateFindings, recordCandidateFinding, updateCandidateFinding } from '../../workflow/findings/store';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { assessWorkMode } from '../../../cli/controller/work-mode';
import type { TaskRisk } from '../../../cli/controller/types';
import { readRepositoryProjection } from '../../projections/materialized-view';
import { controllerContextProjectionAgeMs, readControllerContextProjection } from '../../projections/controller-context';
import { loadMcpRuntimeState } from '../../../cli/mcp/auth';
import { redactMcpText } from '../../../cli/mcp/redaction';
import {
  getLocalBridgeJobEventsSnapshot,
  getLocalBridgeJobSnapshot,
  listLocalBridgeJobSnapshots,
  readLocalBridgeJobOutputSnapshot,
} from '../../../cli/local-bridge/job-store';

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], readOnly = true): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: { readOnlyHint: readOnly, openWorldHint: false, destructiveHint: false },
  };
}
const repoId = { type: 'string', description: 'Stable repository id.' };
export const runtimeToolDefinitions: McpToolDefinition[] = [
  definition('get_job', 'Read one durable Execution Job. Summary is the default; opt in to full state only when needed.', {
    job_id: { type: 'string' },
    repo_id: repoId,
    include_events: { type: 'boolean' },
    detail_level: { type: 'string', enum: ['summary', 'full'] },
  }, ['job_id']),
  definition('get_artifact', 'Read one bounded Evidence Plane artifact by id. Large content remains bounded.', { artifact_id: { type: 'string' }, repo_id: repoId, max_bytes: { type: 'number' } }, ['artifact_id', 'repo_id']),
  definition('list_jobs', 'List durable Execution Jobs for one repository. Summary is the default.', {
    repo_id: repoId,
    limit: { type: 'number' },
    detail_level: { type: 'string', enum: ['summary', 'full'] },
  }),
  definition('cancel_job', 'Cancel one queued or running durable Execution Job.', { job_id: { type: 'string' }, repo_id: repoId, reason: { type: 'string' } }, ['job_id'], false),
  definition('controller_ready', 'Return Gateway, Controller Daemon, Worker isolation, queue, and repository projection readiness.', { repo_id: repoId }),
  definition('repository_runtime_snapshot', 'Read the materialized runtime projection without scanning historical state.', { repo_id: repoId }),
  definition('create_schedule', 'Create a bounded repository Schedule. Shadow mode defaults to true.', {
    repo_id: repoId,
    request_id: { type: 'string' },
    name: { type: 'string' },
    trigger_type: { type: 'string', enum: ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'] },
    every_minutes: { type: 'number' },
    cron_expression: { type: 'string' },
    calendar_at: { type: 'string' },
    condition: { type: 'object' },
    event_name: { type: 'string' },
    dependency_job_ids: { type: 'array', items: { type: 'string' } },
    operation: { type: 'string' },
    arguments: { type: 'object' },
    shadow_mode: { type: 'boolean' },
    daily_budget_minutes: { type: 'number' },
    cooldown_minutes: { type: 'number' },
    backoff_base_minutes: { type: 'number' },
    backoff_max_minutes: { type: 'number' },
    max_failures: { type: 'number' },
    stop_conditions: { type: 'array', items: { type: 'string' } },
  }, ['name', 'operation'], false),
  definition('list_schedules', 'List repository Schedules and recent bounded Occurrences.', { repo_id: repoId, include_occurrences: { type: 'boolean' } }),
  definition('pause_schedule', 'Pause a repository Schedule.', { repo_id: repoId, schedule_id: { type: 'string' }, reason: { type: 'string' } }, ['schedule_id'], false),
  definition('trigger_schedule', 'Create one idempotent bounded Occurrence for a Schedule or deliver a repository event.', {
    repo_id: repoId,
    schedule_id: { type: 'string' },
    event_name: { type: 'string' },
    event_id: { type: 'string' },
    event_data: { type: 'object' },
  }, ['schedule_id'], false),
  definition('request_release_gate', 'Create a durable exclusive Release Gate Job. Push, tag, and publish remain separately authorized.', { repo_id: repoId, request_id: { type: 'string' } }, [], false),
  definition('create_portfolio_workflow', 'Create a cross-repository DAG with deterministic Saga stop/compensation semantics.', {
    name: { type: 'string' }, request_id: { type: 'string' }, failure_policy: { type: 'string', enum: ['stop', 'compensate'] }, steps: { type: 'array', items: { type: 'object' } },
  }, ['name', 'request_id', 'steps'], false),
  definition('list_portfolio_workflows', 'List cross-repository Portfolio workflows.', { limit: { type: 'number' } }),
  definition('get_portfolio_workflow', 'Read one Portfolio workflow and its repository DAG state.', { workflow_id: { type: 'string' } }, ['workflow_id']),
  definition('record_candidate_finding', 'Record or refresh a deduplicated candidate requirement without creating an Issue automatically.', {
    repo_id: repoId, request_id: { type: 'string' }, semantic_key: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, reference: { type: 'string' }, evidence: { type: 'object' },
  }, ['semantic_key', 'title'], false),
  definition('list_candidate_findings', 'List bounded candidate findings awaiting human promotion or dismissal.', { repo_id: repoId, include_terminal: { type: 'boolean' }, limit: { type: 'number' } }),
  definition('promote_candidate_finding', 'Explicitly promote one candidate finding into a durable Issue-creation Job.', {
    repo_id: repoId, finding_id: { type: 'string' }, request_id: { type: 'string' }, kind: { type: 'string', enum: ['bug', 'feature', 'governance', 'investigation'] }, goals: { type: 'array', items: { type: 'string' } }, acceptance_criteria: { type: 'array', items: { type: 'string' } },
  }, ['finding_id'], false),
];

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function repositoryRootForRepoId(controllerHome: string, repoId: string): string | undefined {
  return listRepositories(controllerHome).find((repository) => repository.repoId === repoId)?.canonicalRoot;
}

function scrubPathText(text: string, replacements: string[]): string {
  let output = text;
  for (const replacement of [...new Set(replacements.filter((entry) => entry.startsWith('/')))].sort((left, right) => right.length - left.length)) {
    output = output.split(replacement).join('<repo>');
  }
  output = output
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>');
  return output;
}

function jsonPreview(value: unknown, maxChars = 800, replacements: string[] = []): { preview: string; truncated: boolean; byteLength: number } {
  const serialized = JSON.stringify(value);
  const redacted = redactMcpText(scrubPathText(serialized, replacements)).text;
  const byteLength = Buffer.byteLength(serialized);
  if (redacted.length <= maxChars) return { preview: redacted, truncated: false, byteLength };
  return {
    preview: `${redacted.slice(0, maxChars)}...`,
    truncated: true,
    byteLength,
  };
}

function summarizeJobEvents(controllerHome: string, repoId: string, jobId: string): Array<Record<string, unknown>> {
  const repoRoot = repositoryRootForRepoId(controllerHome, repoId);
  return readJobEvents(controllerHome, repoId, jobId).slice(-20).map((event) => {
    const dataPreview = event.data && Object.keys(event.data).length > 0 ? jsonPreview(event.data, 240, repoRoot ? [repoRoot] : []) : undefined;
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      revision: event.revision,
      ...(dataPreview ? { dataPreview: dataPreview.preview, dataTruncated: dataPreview.truncated } : {}),
    };
  });
}

function summarizeExecutionJob(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  const payloadArguments = job.payload.arguments && typeof job.payload.arguments === 'object'
    ? Object.keys(job.payload.arguments as Record<string, unknown>).slice(0, 20)
    : undefined;
  const replacements = repoRoot ? [repoRoot] : [];
  const resultPreview = job.result !== undefined ? jsonPreview(job.result, 320, replacements) : undefined;
  const errorPreview = job.error?.details !== undefined ? jsonPreview(job.error.details, 320, replacements) : undefined;
  return {
    jobId: job.jobId,
    repoId: job.repoId,
    checkoutId: job.checkoutId,
    type: job.type,
    status: job.status,
    priority: job.priority,
    requestId: job.requestId,
    semanticKey: job.semanticKey,
    payload: {
      operation: job.payload.operation,
      target: job.payload.target,
      profile: job.payload.profile,
      timeoutMs: job.payload.timeoutMs,
      maxOutputBytes: job.payload.maxOutputBytes,
      argumentKeys: payloadArguments,
      summaryOnly: true,
    },
    origin: job.origin,
    resourceClaims: job.resourceClaims,
    dependencies: job.dependencies,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    heartbeatAt: job.heartbeatAt,
    deadlineAt: job.deadlineAt,
    workerPid: job.workerPid,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    evidenceIds: job.evidenceIds,
    result: resultPreview
      ? {
        preview: resultPreview.preview,
        truncated: resultPreview.truncated,
        byteLength: resultPreview.byteLength,
        next: 'Call get_job with detail_level=full or get_artifact if an artifactId is present.',
      }
      : undefined,
    error: job.error
      ? {
        code: job.error.code,
        message: redactMcpText(scrubPathText(job.error.message, replacements)).text,
        retryable: job.error.retryable,
        ...(errorPreview
          ? {
            detailsPreview: errorPreview.preview,
            detailsTruncated: errorPreview.truncated,
            detailsByteLength: errorPreview.byteLength,
          }
          : {}),
      }
      : undefined,
  };
}


function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}

function controllerContextAssessment(args: Record<string, unknown>) {
  if (typeof args.description !== 'string' || !args.description.trim()) return undefined;
  return assessWorkMode({
    description: args.description,
    knownPaths: stringList(args.known_paths),
    expectedFiles: typeof args.expected_files === 'number' ? args.expected_files : undefined,
    expectedChangedLines: typeof args.expected_changed_lines === 'number' ? args.expected_changed_lines : undefined,
    requiresInvestigation: args.requires_investigation === true,
    requiresParallelism: args.requires_parallelism === true,
    requiresLongRunningChecks: args.requires_long_running_checks === true,
    needsDependencies: args.needs_dependencies === true,
    risk: typeof args.risk === 'string' ? args.risk as TaskRisk : undefined,
  });
}

function selected(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>) {
  return resolveRepositorySelection({
    repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
    explicitPath: ctx.explicitRepository?.canonicalRoot,
    controllerHome: ctx.controllerHome,
    allowSoleRepository: true,
  });
}

const SCHEDULER_HEARTBEAT_STALE_MS = 5_000;
const QUEUE_PROGRESS_STALE_MS = 10_000;

function ageMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : undefined;
}

function controllerReadiness(ctx: MultiRepositoryMcpToolContext, repository = ctx.explicitRepository) {
  const daemon = readControllerDaemonStatus(ctx.controllerHome);
  const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
  const projection = repository ? readRepositoryProjection(ctx.controllerHome, repository.repoId) : undefined;
  const localBridge = repository ? loadMcpRuntimeState(repository.canonicalRoot)?.localController : undefined;
  const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
  const dispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
  const schedulerFresh = daemon.status === 'ready'
    && schedulerHeartbeatAgeMs !== undefined
    && schedulerHeartbeatAgeMs <= SCHEDULER_HEARTBEAT_STALE_MS;
  const reasons: Array<{ code: string; message: string }> = [];

  if (daemon.status !== 'ready') {
    reasons.push({
      code: 'DAEMON_NOT_READY',
      message: `Controller daemon is ${daemon.status}.`,
    });
  }

  if (projection?.queueDepth && !schedulerFresh) {
    reasons.push({
      code: 'DISPATCH_LOOP_STALLED',
      message: 'The durable scheduler heartbeat is stale while queued Jobs are waiting.',
    });
  }

  if (projection?.queueDepth && projection.runningWorkers === 0 && projection.activeLeases === 0) {
    reasons.push({
      code: 'WORKER_NOT_RUNNING',
      message: 'Queued Jobs exist but no Worker is currently running.',
    });
    if (dispatchHeartbeatAgeMs === undefined || dispatchHeartbeatAgeMs > QUEUE_PROGRESS_STALE_MS) {
      reasons.push({
        code: 'QUEUE_NOT_PROGRESSING',
        message: 'Queued Jobs have not received a recent dispatch heartbeat.',
      });
    }
  }

  const ready = reasons.length === 0;
  return {
    ready,
    state: ready ? 'ready' as const : daemon.status === 'ready' ? 'degraded' as const : 'not_ready' as const,
    reasons,
    daemon,
    durableScheduler: {
      status: schedulerFresh ? 'ready' : daemon.status === 'ready' ? 'degraded' : 'not_ready',
      loopStartedAt: scheduler.loopStartedAt,
      lastTickAt: scheduler.lastTickAt,
      lastDispatchAt: scheduler.lastDispatchAt,
      lastReconcileAt: scheduler.lastReconcileAt,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs,
    },
    workerLoop: {
      status: projection?.runningWorkers ? 'running' : projection?.queueDepth ? 'idle' : 'ready',
      queueDepth: projection?.queueDepth ?? 0,
      runningWorkers: projection?.runningWorkers ?? 0,
      activeLeases: projection?.activeLeases ?? 0,
      consuming: (projection?.queueDepth ?? 0) === 0 || (projection?.runningWorkers ?? 0) > 0,
    },
    localBridge: repository ? {
      running: localBridge?.running ?? false,
      endpoint: localBridge?.endpoint,
      error: localBridge?.error,
    } : undefined,
    projection,
  };
}

export async function callRuntimeTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'local_bridge_status': {
        const repository = selected(ctx, args);
        const runtime = loadMcpRuntimeState(repository.canonicalRoot);
        const jobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 12);
        const active = jobs.filter((job) => ['approved', 'running', 'dispatched'].includes(job.status)).length;
        return result({
          endpoint: runtime?.localController?.endpoint ?? 'http://127.0.0.1:8766/',
          running: runtime?.localController?.running ?? false,
          error: runtime?.localController?.error,
          counts: jobs.reduce<Record<string, number>>((counts, job) => {
            counts[job.status] = (counts[job.status] ?? 0) + 1;
            return counts;
          }, {}),
          approvalQueue: false,
          reconciliation: { scanned: jobs.length, active, terminalized: 0, deferredToController: true },
          recentJobs: jobs.map((job) => ({
            jobId: job.jobId,
            action: job.action,
            status: job.status,
            checkId: job.action === 'run-check' ? (job.payload as { checkId?: string }).checkId : undefined,
            runId: job.runId,
            issueId: job.issueId,
            taskId: job.taskId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            finishedAt: job.finishedAt,
            revision: job.revision,
            deadlineAt: job.deadlineAt,
            error: job.error?.slice(0, 300),
          })),
          fallback: 'Open the localhost Local Controller to launch work or inspect execution when a ChatGPT write action is unavailable.',
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'get_local_job': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        const job = getLocalBridgeJobSnapshot(repository.canonicalRoot, jobId);
        return result({
          job,
          ...(args.include_events === true ? { events: getLocalBridgeJobEventsSnapshot(repository.canonicalRoot, jobId) } : {}),
          ...(args.include_output === true ? { output: readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
            stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }) } : {}),
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'get_local_job_output': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        return result({
          ...readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
            stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }),
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'controller_context': {
        const repository = selected(ctx, args);
        const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
        const runtimeProjection = readRepositoryProjection(ctx.controllerHome, repository.repoId);
        const cached = readControllerContextProjection(ctx.controllerHome, repository.repoId);
        const ageMs = controllerContextProjectionAgeMs(cached);
        const stale = ageMs > 10_000;
        const readiness = controllerReadiness(ctx, repository);
        let refreshJobId: string | undefined;
        let refreshError: string | undefined;
        let refreshBlockedReason: string | undefined;
        if (stale) {
          if (!readiness.ready) {
            refreshBlockedReason = readiness.reasons[0]?.code;
            refreshError = readiness.reasons[0]?.message;
          } else {
            try {
              const requestId = `projection:controller-context:${repository.repoId}:${Math.floor(Date.now() / 10_000)}`;
              const created = createExecutionJob(ctx.controllerHome, {
                repoId: repository.repoId,
                checkoutId: repository.activeCheckoutId,
                type: 'mcp-tool',
                requestId,
                semanticKey: `projection:controller-context:${repository.repoId}`,
                origin: { surface: 'mcp', actor: 'controller_context', correlationId: requestId },
                payload: {
                  operation: 'controller_context',
                  arguments: {},
                  target: 'mcp-tool',
                  profile: ctx.policy.profile,
                  enableChatgptBrowser: ctx.enableChatgptBrowser === true,
                  enableDevRunner: ctx.policy.execution.agentRunner,
                  allowedAgents: [...ctx.policy.execution.allowedAgents],
                  runnerTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
                  runnerMaxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
                },
                priority: 'P1',
                resourceClaims: [],
                timeoutMs: 45_000,
                maxAttempts: 1,
              });
              refreshJobId = created.job.jobId;
              ensureControllerDaemon(ctx.controllerHome);
            } catch (error) {
              refreshError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        const activeCheckout = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
        const fallback: Record<string, unknown> = {
          git: {
            branch: activeCheckout?.branch ?? null,
            status: 'Materialized context is being refreshed by an isolated Worker.',
            diffStat: '',
          },
          currentIssueId: undefined,
          currentIssue: undefined,
          readyTasks: [],
          activeRuns: runtimeProjection.activeJobs,
          localBridge: { reconciliation: { scanned: 0, active: 0, terminalized: 0 }, recentJobs: [] },
          checks: [],
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage,
        };
        return result({
          ...(cached?.payload ?? fallback),
          recommendedExecution: controllerContextAssessment(args),
          runtimeProjection,
          contextProjection: {
            generatedAt: cached?.generatedAt,
            ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
            stale,
            refreshJobId,
            refreshBlockedReason,
            refreshError,
            nonBlocking: true,
          },
          controllerReady: readiness,
        });
      }
      case 'get_job': {
        const jobId = String(args.job_id ?? '').trim();
        const job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
        if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId } }, true);
        const full = args.detail_level === 'full';
        const repoRoot = repositoryRootForRepoId(ctx.controllerHome, job.repoId);
        return result({
          detailLevel: full ? 'full' : 'summary',
          job: full ? job : summarizeExecutionJob(job, repoRoot),
          ...(args.include_events === true
            ? { events: full ? readJobEvents(ctx.controllerHome, job.repoId, job.jobId) : summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) }
            : {}),
          ...(full ? {} : { next: 'Call get_job with detail_level=full only when the summary is insufficient.' }),
        });
      }
      case 'get_artifact': {
        const artifactId = String(args.artifact_id ?? '').trim();
        const artifactRepoId = String(args.repo_id ?? '').trim();
        return result(readExecutionArtifact(ctx.controllerHome, artifactRepoId, artifactId, typeof args.max_bytes === 'number' ? args.max_bytes : undefined) as unknown as Record<string, unknown>);
      }
      case 'list_jobs': {
        const repository = selected(ctx, args);
        const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, typeof args.limit === 'number' ? args.limit : 100);
        const full = args.detail_level === 'full';
        return result({
          detailLevel: full ? 'full' : 'summary',
          jobs: full ? jobs : jobs.map((job) => summarizeExecutionJob(job, repository.canonicalRoot)),
          ...(full ? {} : { next: 'Call get_job with one job_id for more detail.' }),
        });
      }
      case 'cancel_job': {
        const jobId = String(args.job_id ?? '').trim();
        const job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
        if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId } }, true);
        return result({ job: await cancelExecutionJob(ctx.controllerHome, job.repoId, job.jobId, typeof args.reason === 'string' ? args.reason : undefined) });
      }
      case 'controller_ready': {
        const explicitRepoId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
        const registered = listRepositories(ctx.controllerHome).filter((repository) => repository.enabled && !repository.removedAt);
        const repository = explicitRepoId
          ? selected(ctx, args)
          : (ctx.explicitRepository ?? (registered.length === 1 ? registered[0] : undefined));
        const readiness = controllerReadiness(ctx, repository);
        return result({
          ready: readiness.ready,
          state: readiness.state,
          gateway: { ready: true, thin: true, longOperationsAreDurable: true },
          daemon: readiness.daemon,
          durableScheduler: readiness.durableScheduler,
          workerLoop: readiness.workerLoop,
          localBridge: readiness.localBridge,
          reasons: readiness.reasons,
          registeredRepositories: registered.length,
          ...(repository ? { repository: readiness.projection ?? rebuildRepositoryProjection(ctx.controllerHome, repository.repoId) } : {}),
        });
      }
      case 'repository_runtime_snapshot': {
        const repository = selected(ctx, args);
        return result({ snapshot: rebuildRepositoryProjection(ctx.controllerHome, repository.repoId) });
      }
      case 'create_schedule': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? '').trim();
        const operationArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments as Record<string, unknown> : {};
        assertAutomatedOperationAllowed(operation, operationArgs);
        const scheduleRequestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `schedule:auto:${repository.repoId}:${createHash('sha256').update(JSON.stringify({ name: args.name, operation, arguments: operationArgs, everyMinutes: args.every_minutes })).digest('hex').slice(0, 20)}:${Math.floor(Date.now() / (5 * 60_000))}`;
        const schedule = createSchedule(ctx.controllerHome, {
          requestId: scheduleRequestId,
          repoId: repository.repoId,
          name: String(args.name ?? '').trim(),
          enabled: true,
          trigger: {
            type: ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'].includes(String(args.trigger_type))
              ? String(args.trigger_type) as 'interval' | 'cron' | 'calendar' | 'condition' | 'repository-event' | 'dependency-checkpoint' | 'manual'
              : typeof args.every_minutes === 'number' ? 'interval' : 'manual',
            everyMinutes: typeof args.every_minutes === 'number' ? Math.max(1, args.every_minutes) : undefined,
            cronExpression: typeof args.cron_expression === 'string' ? args.cron_expression : undefined,
            calendarAt: typeof args.calendar_at === 'string' ? args.calendar_at : undefined,
            condition: args.condition && typeof args.condition === 'object' ? args.condition as never : undefined,
            eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
            dependencyJobIds: Array.isArray(args.dependency_job_ids) ? args.dependency_job_ids.map(String) : undefined,
          },
          policy: {
            maxActiveOccurrences: 1,
            maxFailures: typeof args.max_failures === 'number' ? Math.max(1, args.max_failures) : 3,
            cooldownMinutes: typeof args.cooldown_minutes === 'number' ? Math.max(0, args.cooldown_minutes) : 120,
            dailyBudgetMinutes: typeof args.daily_budget_minutes === 'number' ? Math.max(1, args.daily_budget_minutes) : 180,
            shadowMode: args.shadow_mode !== false,
            backoffBaseMinutes: typeof args.backoff_base_minutes === 'number' ? Math.max(1, args.backoff_base_minutes) : 5,
            backoffMaxMinutes: typeof args.backoff_max_minutes === 'number' ? Math.max(1, args.backoff_max_minutes) : 24 * 60,
          },
          action: { operation, arguments: operationArgs, resourceClaims: claimsForMcpOperation(operation, operationArgs, repository.repoId, repository.activeCheckoutId) },
          stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : ['release_ready', 'external_blocker', 'human_review_required'],
        });
        return result({ schedule });
      }
      case 'list_schedules': {
        const repository = selected(ctx, args);
        const schedules = listSchedules(ctx.controllerHome, repository.repoId);
        if (args.include_occurrences !== true) return result({ schedules });
        const occurrences = listOccurrences(ctx.controllerHome, repository.repoId, undefined, 100);
        const decisions = occurrences.flatMap((occurrence) => occurrence.decisionId
          ? [getScheduleDecision(ctx.controllerHome, repository.repoId, occurrence.decisionId)].filter(Boolean)
          : []);
        return result({ schedules, occurrences, decisions });
      }
      case 'pause_schedule': {
        const repository = selected(ctx, args);
        const schedule = getSchedule(ctx.controllerHome, repository.repoId, String(args.schedule_id ?? ''));
        return result({ schedule: saveSchedule(ctx.controllerHome, { ...schedule, enabled: false, pausedReason: typeof args.reason === 'string' ? args.reason : 'Paused by user.' }) });
      }
      case 'trigger_schedule': {
        const repository = selected(ctx, args);
        const schedule = getSchedule(ctx.controllerHome, repository.repoId, String(args.schedule_id ?? ''));
        const occurrence = await evaluateSchedule(ctx.controllerHome, schedule, true, {
          source: typeof args.event_name === 'string' ? 'repository-event' : 'manual',
          eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
          eventId: typeof args.event_id === 'string' ? args.event_id : undefined,
          data: args.event_data && typeof args.event_data === 'object' ? args.event_data as Record<string, unknown> : undefined,
        });
        ensureControllerDaemon(ctx.controllerHome);
        return result({ occurrence });
      }
      case 'request_release_gate': {
        const repository = selected(ctx, args);
        const requestId = typeof args.request_id === 'string' && args.request_id.trim() ? args.request_id.trim() : `release:${repository.repoId}:${Math.floor(Date.now() / 60_000)}`;
        const created = createExecutionJob(ctx.controllerHome, {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          type: 'release-gate',
          requestId,
          semanticKey: `release-gate:${repository.repoId}`,
          origin: { surface: 'mcp', actor: 'request_release_gate' },
          payload: { operation: 'release-gate', target: 'runtime' },
          priority: 'P1',
          resourceClaims: [{ resourceKey: `release:${repository.repoId}`, mode: 'exclusive' }],
          timeoutMs: 15 * 60_000,
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({ accepted: true, jobId: created.job.jobId, status: created.job.status, deduplicated: created.deduplicated, daemon, next: `Call get_job with ${created.job.jobId}.` });
      }
      case 'create_portfolio_workflow': {
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        const workflow = createPortfolioWorkflow(ctx.controllerHome, {
          name: String(args.name ?? '').trim(),
          requestId: String(args.request_id ?? '').trim(),
          failurePolicy: args.failure_policy === 'compensate' ? 'compensate' : 'stop',
          steps: rawSteps.map((raw, index) => {
            if (!raw || typeof raw !== 'object') throw new Error(`PORTFOLIO_STEP_INVALID: step ${index + 1}`);
            const step = raw as Record<string, unknown>;
            const stepRepoId = String(step.repo_id ?? '').trim();
            const operation = String(step.operation ?? '').trim();
            const operationArgs = step.arguments && typeof step.arguments === 'object' ? step.arguments as Record<string, unknown> : {};
            if (!stepRepoId || !operation) throw new Error(`PORTFOLIO_STEP_INVALID: step ${index + 1} requires repo_id and operation`);
            assertAutomatedOperationAllowed(operation, operationArgs);
            const checkoutId = resolveRepositorySelection({ repoId: stepRepoId, controllerHome: ctx.controllerHome, allowSoleRepository: false }).activeCheckoutId;
            const compensation = step.compensation && typeof step.compensation === 'object'
              ? step.compensation as Record<string, unknown>
              : undefined;
            if (compensation) {
              const compensationOperation = String(compensation.operation ?? '').trim();
              const compensationArguments = compensation.arguments && typeof compensation.arguments === 'object'
                ? compensation.arguments as Record<string, unknown>
                : {};
              assertAutomatedOperationAllowed(compensationOperation, compensationArguments);
            }
            return {
              stepId: String(step.step_id ?? `step-${index + 1}`),
              repoId: stepRepoId,
              operation,
              arguments: operationArgs,
              dependsOn: Array.isArray(step.depends_on) ? step.depends_on.map(String) : [],
              priority: ['P0', 'P1', 'P2', 'P3', 'P4'].includes(String(step.priority)) ? String(step.priority) as 'P0' | 'P1' | 'P2' | 'P3' | 'P4' : 'P2',
              resourceClaims: claimsForMcpOperation(operation, operationArgs, stepRepoId, checkoutId),
              compensation: compensation ? { operation: String(compensation.operation ?? ''), arguments: compensation.arguments && typeof compensation.arguments === 'object' ? compensation.arguments as Record<string, unknown> : undefined } : undefined,
              status: 'pending' as const,
            };
          }),
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({ workflow, daemon: { status: daemon.status, pid: daemon.pid } });
      }
      case 'list_portfolio_workflows':
        return result({ workflows: listPortfolioWorkflows(ctx.controllerHome, typeof args.limit === 'number' ? args.limit : 100) });
      case 'get_portfolio_workflow':
        return result({ workflow: getPortfolioWorkflow(ctx.controllerHome, String(args.workflow_id ?? '')) });
      case 'record_candidate_finding': {
        const repository = selected(ctx, args);
        const semanticKey = String(args.semantic_key ?? '').trim();
        const requestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `candidate:${repository.repoId}:${createHash('sha256').update(semanticKey).digest('hex').slice(0, 20)}:${Math.floor(Date.now() / (5 * 60_000))}`;
        const finding = recordCandidateFinding(ctx.controllerHome, {
          repoId: repository.repoId,
          requestId,
          semanticKey,
          title: String(args.title ?? '').trim(),
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          severity: ['low', 'medium', 'high', 'critical'].includes(String(args.severity))
            ? String(args.severity) as 'low' | 'medium' | 'high' | 'critical'
            : 'medium',
          evidence: {
            source: 'mcp',
            reference: typeof args.reference === 'string' ? args.reference : undefined,
            details: args.evidence && typeof args.evidence === 'object' ? args.evidence as Record<string, unknown> : undefined,
          },
        });
        return result({ finding });
      }
      case 'list_candidate_findings': {
        const repository = selected(ctx, args);
        return result({ findings: listCandidateFindings(ctx.controllerHome, repository.repoId, {
          includeTerminal: args.include_terminal === true,
          limit: typeof args.limit === 'number' ? args.limit : 100,
        }) });
      }
      case 'promote_candidate_finding': {
        const repository = selected(ctx, args);
        const finding = getCandidateFinding(ctx.controllerHome, repository.repoId, String(args.finding_id ?? ''));
        if (finding.promotedJobId) {
          const existing = findExecutionJob(ctx.controllerHome, finding.promotedJobId);
          if (existing && !['failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(existing.status)) {
            return result({ accepted: true, finding, jobId: finding.promotedJobId, status: existing.status, deduplicated: true });
          }
          if (existing?.status === 'succeeded' && finding.status === 'promoted') {
            return result({ accepted: true, finding, jobId: finding.promotedJobId, status: existing.status, deduplicated: true });
          }
        }
        const requestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `candidate-promotion:${repository.repoId}:${finding.findingId}`;
        const created = createExecutionJob(ctx.controllerHome, {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          type: 'mcp-tool',
          requestId,
          semanticKey: `candidate-promotion:${finding.findingId}:${finding.semanticKey}`,
          origin: { surface: 'mcp', actor: 'promote_candidate_finding', correlationId: finding.findingId },
          payload: {
            operation: 'create_issue',
            target: 'mcp-tool',
            profile: ctx.policy.profile,
            arguments: {
              title: finding.title,
              summary: finding.summary,
              kind: typeof args.kind === 'string' ? args.kind : 'investigation',
              goals: Array.isArray(args.goals) ? args.goals.map(String) : [],
              acceptance_criteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : [],
              related_artifacts: finding.evidence.map((entry) => entry.reference).filter((value): value is string => Boolean(value)),
            },
          },
          priority: finding.severity === 'critical' ? 'P0' : finding.severity === 'high' ? 'P1' : 'P2',
          resourceClaims: [{ resourceKey: 'repo-state', mode: 'write' }],
          maxAttempts: 1,
        });
        const promoted = updateCandidateFinding(ctx.controllerHome, repository.repoId, finding.findingId, (current) => ({
          ...current,
          status: 'candidate',
          promotedJobId: created.job.jobId,
        }), requestId, 'candidate_promotion_requested');
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({ accepted: true, finding: promoted, jobId: created.job.jobId, status: created.job.status, deduplicated: created.deduplicated, daemon, next: `Call get_job with ${created.job.jobId}.` });
      }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result({ error: { code: message.includes(':') ? message.split(':', 1)[0] : 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
