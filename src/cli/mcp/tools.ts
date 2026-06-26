/**
 * Legacy Controller MCP compatibility facade.
 *
 * Gateway code imports the stable tool schema and result types from this
 * module, while the compatibility implementation itself is isolated in
 * legacy-tool-service.ts and is invoked for long work only by Worker
 * processes through the durable ExecutionJob pipeline.
 */
import {
  buildMcpToolDefinitions as buildLegacyMcpToolDefinitions,
  callMcpTool as callLegacyMcpTool,
  type CallToolResult,
  type McpToolContext,
  type McpToolDefinition,
} from './legacy-tool-service';
import type { McpPolicy } from './types';

export * from './legacy-tool-service';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

function parseJsonResult(result: CallToolResult): JsonObject | undefined {
  const text = result.content[0]?.text;
  if (!text) return undefined;
  try {
    return asObject(JSON.parse(text));
  } catch (_error) {
    return undefined;
  }
}

function replaceJsonResult(result: CallToolResult, value: JsonObject): CallToolResult {
  return {
    ...result,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function summarizeTask(taskValue: unknown): JsonObject {
  const task = asObject(taskValue);
  const effectiveState = asObject(task.effectiveState);
  return {
    id: task.id,
    title: boundedText(task.title, 240),
    status: task.status,
    declaredStatus: task.declaredStatus ?? effectiveState.declaredStatus,
    effectiveStatus: task.effectiveStatus ?? effectiveState.effectiveStatus,
    statusReason: boundedText(task.statusReason ?? effectiveState.reason, 400),
    dependsOn: task.dependsOn,
    risk: task.risk,
    latestRunId: task.latestRunId ?? effectiveState.latestRunId,
    latestRunStatus: task.latestRunStatus ?? effectiveState.latestRunStatus,
    activeRunId: task.activeRunId ?? effectiveState.activeRunId,
    activeRunStatus: task.activeRunStatus ?? effectiveState.activeRunStatus,
    verificationStatus: task.verificationStatus ?? effectiveState.verificationStatus,
    terminal: task.terminal ?? effectiveState.terminal,
    inactive: task.inactive ?? effectiveState.inactive,
    dispatchable: task.dispatchable ?? effectiveState.dispatchable,
    retryable: task.retryable ?? effectiveState.retryable,
    requiresExplicitRetry:
      task.requiresExplicitRetry ?? effectiveState.requiresExplicitRetry,
    dependencyState: task.dependencyState,
  };
}

function summarizeIssue(issue: JsonObject): JsonObject {
  const tasks = asArray(issue.tasks);
  const taskCounts = tasks.reduce<Record<string, number>>((counts, value) => {
    const task = asObject(value);
    const status = String(task.effectiveStatus ?? task.status ?? 'unknown');
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    detailLevel: 'summary',
    schemaVersion: issue.schemaVersion,
    id: issue.id,
    title: boundedText(issue.title, 240),
    slug: issue.slug,
    kind: issue.kind,
    status: issue.status,
    lifecycleStatus: issue.lifecycleStatus,
    summary: boundedText(issue.summary, 800),
    github: issue.github,
    archivedAt: issue.archivedAt,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    taskCount: tasks.length,
    taskCounts,
    tasks: tasks.map(summarizeTask),
    next: `Call get_issue with issue_id=${String(issue.id ?? '')} and detail_level=full for goals, notes, verification, and full Run history.`,
  };
}

function summarizeRun(runValue: unknown): JsonObject {
  const run = asObject(runValue);
  return {
    runId: run.runId,
    issueId: run.issueId,
    taskId: run.taskId,
    agent: run.agent,
    provider: run.provider,
    executionMode: run.executionMode,
    executionClass: run.executionClass,
    status: run.status,
    exitCode: run.exitCode,
    error: boundedText(run.error, 1_000),
    timeoutMs: run.timeoutMs,
    deadlineAt: run.deadlineAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    worktreeCleanedAt: run.worktreeCleanedAt,
    integratedSessionId: run.integratedSessionId,
    integratedAt: run.integratedAt,
    github: run.github,
  };
}

function summarizeTimelineEvent(eventValue: unknown): JsonObject {
  const event = asObject(eventValue);
  return {
    id: event.id,
    at: event.at,
    category: event.category,
    action: event.action,
    summary: boundedText(event.summary, 500),
    actor: event.actor,
    issueId: event.issueId,
    taskId: event.taskId,
    runId: event.runId,
    editSessionId: event.editSessionId,
    statusFrom: event.statusFrom,
    statusTo: event.statusTo,
  };
}

function summarizeProgress(progressValue: unknown): JsonObject {
  const progress = asObject(progressValue);
  const completion = asObject(progress.completion);
  return {
    issueId: progress.issueId,
    taskId: progress.taskId,
    title: boundedText(progress.title, 240),
    status: progress.status,
    effectiveStatus: progress.effectiveStatus,
    statusReason: boundedText(progress.statusReason, 400),
    issueLifecycleStatus: progress.issueLifecycleStatus,
    requiresExplicitRetry: progress.requiresExplicitRetry,
    retryable: progress.retryable,
    percent: progress.percent,
    completion: {
      completedGates: completion.completedGates,
      totalGates: completion.totalGates,
    },
    latestRunId: progress.latestRunId,
    latestRunStatus: progress.latestRunStatus,
    currentActivity: boundedText(progress.currentActivity, 500),
    lastActivityAt: progress.lastActivityAt,
    elapsedMs: progress.elapsedMs,
    runCount: progress.runCount,
    notesCount: progress.notesCount,
    blockedBy: progress.blockedBy,
    risk: progress.risk,
    agent: progress.agent,
    verification: progress.verification,
    githubUrl: progress.githubUrl,
  };
}

function summarizeTaskProgress(
  detail: JsonObject,
  timelineLimit: number,
): JsonObject {
  const allRuns = asArray(detail.runs);
  const allTimeline = asArray(detail.timeline);
  const runs = allRuns.slice(-10).map(summarizeRun);
  const timeline = allTimeline.slice(0, timelineLimit).map(summarizeTimelineEvent);
  return {
    detailLevel: 'summary',
    issue: detail.issue,
    task: summarizeTask(detail.task),
    progress: summarizeProgress(detail.progress),
    runCount: allRuns.length,
    runs,
    runsTruncated: allRuns.length > runs.length,
    timeline,
    timelineTruncated: allTimeline.length > timeline.length,
    next: 'Call get_task_progress_detail with detail_level=full for full Task evidence, Run metadata, and timeline details.',
  };
}

function extendReadSchema(
  tool: McpToolDefinition,
  properties: JsonObject,
  description: string,
): McpToolDefinition {
  const inputSchema = asObject(tool.inputSchema);
  return {
    ...tool,
    description,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...asObject(inputSchema.properties),
        ...properties,
      },
    },
  };
}

export function buildMcpToolDefinitions(
  policy: McpPolicy,
  opts: { enableChatgptBrowser?: boolean } = {},
): McpToolDefinition[] {
  return buildLegacyMcpToolDefinitions(policy, opts).map((tool) => {
    if (tool.name === 'get_issue') {
      return extendReadSchema(
        tool,
        { detail_level: { type: 'string', enum: ['summary', 'full'] } },
        'Read a bounded Issue summary by default; set detail_level=full for complete Task evidence.',
      );
    }
    if (tool.name === 'get_task_progress_detail') {
      return extendReadSchema(
        tool,
        {
          detail_level: { type: 'string', enum: ['summary', 'full'] },
          timeline_limit: { type: 'number' },
        },
        'Return bounded Task progress by default; set detail_level=full for complete Run and timeline evidence.',
      );
    }
    return tool;
  });
}

export async function callMcpTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result = await callLegacyMcpTool(ctx, name, args);
  if (result.isError || (name !== 'get_issue' && name !== 'get_task_progress_detail')) {
    return result;
  }
  const value = parseJsonResult(result);
  if (!value) return result;

  if (name === 'get_issue') {
    return replaceJsonResult(
      result,
      args.detail_level === 'full'
        ? { ...value, detailLevel: 'full' }
        : summarizeIssue(value),
    );
  }

  const allTimeline = asArray(value.timeline);
  const full = args.detail_level === 'full';
  const timelineLimit = boundedInteger(
    args.timeline_limit,
    full ? allTimeline.length || 300 : 25,
    300,
  );
  if (full) {
    return replaceJsonResult(result, {
      ...value,
      detailLevel: 'full',
      timeline: allTimeline.slice(0, timelineLimit),
      timelineTruncated: allTimeline.length > timelineLimit,
    });
  }
  return replaceJsonResult(result, summarizeTaskProgress(value, timelineLimit));
}
