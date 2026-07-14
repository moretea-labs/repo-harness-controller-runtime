import { redactMcpText } from '../../cli/mcp/redaction';
import type { ExecutionJob } from '../execution/jobs/types';
import { buildJobOperationDigest } from '../control-plane/facade/operation-digest';
import {
  childReferenceFromJob,
  hasDurableChildReference,
  isAgentDelegationOperation,
} from '../execution/jobs/child-reference';
import type { SafeJobResultSummary } from './types';

type SafeErrorClass = NonNullable<SafeJobResultSummary['safeError']>['class'];
type SafeArtifactRef = NonNullable<SafeJobResultSummary['artifactRefs']>[number];

function scrubPathText(text: string, replacements: string[] = []): string {
  let output = text;
  for (const replacement of [...new Set(replacements.filter((entry) => entry.startsWith('/')))].sort((left, right) => right.length - left.length)) {
    output = output.split(replacement).join('<repo>');
  }
  return output
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>');
}

function sanitizeMessage(message: string, replacements: string[] = []): string {
  return redactMcpText(scrubPathText(message, replacements)).text.slice(0, 800);
}

function classifyError(message: string): SafeErrorClass {
  const lowered = message.toLowerCase();
  if (lowered.includes('playwright') && (lowered.includes('executable doesn\'t exist') || lowered.includes('install'))) return 'dependency_missing';
  if (lowered.includes('policy') || lowered.includes('not allowed') || lowered.includes('denied')) return 'policy_denied';
  if (lowered.includes('confirmation') || lowered.includes('authorization')) return 'authorization_required';
  if (lowered.includes('blocked by openai') || lowered.includes('safety checks') || lowered.includes('平台') || lowered.includes('拦截')) return 'platform_blocked';
  if (lowered.includes('runtime') || lowered.includes('daemon') || lowered.includes('worker')) return 'runtime_error';
  return 'unknown';
}

function safeString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = sanitizeMessage(value);
  return sanitized.length > maxChars ? sanitized.slice(0, maxChars) : sanitized;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonPreview(value: unknown, maxChars = 800, replacements: string[] = []): { preview: string; truncated: boolean; byteLength: number } | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  const redacted = redactMcpText(scrubPathText(serialized, replacements)).text;
  const byteLength = Buffer.byteLength(serialized);
  if (redacted.length <= maxChars) return { preview: redacted, truncated: false, byteLength };
  return { preview: `${redacted.slice(0, maxChars)}...`, truncated: true, byteLength };
}

function collectArtifactRefsFromValue(value: unknown, refs: SafeArtifactRef[], seen: Set<unknown>, depth = 0): void {
  if (refs.length >= 10 || depth > 5 || !value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectArtifactRefsFromValue(entry, refs, seen, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const artifactId = typeof record.artifactId === 'string' ? record.artifactId : undefined;
  if (artifactId && !refs.some((entry) => entry.artifactId === artifactId)) {
    refs.push({
      artifactId,
      artifactKind: typeof record.artifactKind === 'string' ? record.artifactKind : undefined,
      byteLength: typeof record.byteLength === 'number' ? record.byteLength : undefined,
      next: typeof record.next === 'string' ? sanitizeMessage(record.next) : undefined,
    });
  }
  for (const entry of Object.values(record)) collectArtifactRefsFromValue(entry, refs, seen, depth + 1);
}

function collectArtifactRefs(...values: unknown[]): SafeArtifactRef[] {
  const refs: SafeArtifactRef[] = [];
  const seen = new Set<unknown>();
  for (const value of values) collectArtifactRefsFromValue(value, refs, seen);
  return refs;
}

function safeTextPreview(value: unknown): Record<string, unknown> | undefined {
  const text = objectValue(value);
  if (!text) return undefined;
  const preview = safeString(text.text, 4000);
  if (preview === undefined) return undefined;
  return { text: preview, truncated: text.truncated === true, charCount: typeof text.charCount === 'number' ? text.charCount : preview.length };
}

function safeSessionPreview(value: unknown): Record<string, unknown> | undefined {
  const session = objectValue(value);
  if (!session) return undefined;
  return { sessionId: safeString(session.sessionId, 120), url: safeString(session.url, 500), title: safeString(session.title, 300) };
}

function safeScreenshotPreview(value: unknown): Record<string, unknown> | undefined {
  const screenshot = objectValue(value);
  if (!screenshot) return undefined;
  return { url: safeString(screenshot.url, 500), title: safeString(screenshot.title, 300), relativePath: safeString(screenshot.relativePath, 500), bytes: typeof screenshot.bytes === 'number' ? screenshot.bytes : undefined };
}

function safeBrowserResultPreview(actionId: string | undefined, result: unknown): Record<string, unknown> | undefined {
  const outer = objectValue(result);
  const payload = objectValue(outer?.result) ?? outer;
  if (!payload) return undefined;
  const session = safeSessionPreview(payload.session) ?? { sessionId: safeString(payload.sessionId, 120), url: safeString(payload.url, 500), title: safeString(payload.title, 300) };
  const preview: Record<string, unknown> = { provider: payload.provider === 'playwright' ? 'playwright' : undefined, actionId, session, url: safeString(payload.url, 500), title: safeString(payload.title, 300), text: safeTextPreview(payload.text), screenshot: safeScreenshotPreview(payload.screenshot) };
  return Object.fromEntries(Object.entries(preview).filter(([, value]) => value !== undefined));
}

function suggestedFixesFor(message: string, errorClass: SafeErrorClass): string[] {
  const lowered = message.toLowerCase();
  if (errorClass === 'dependency_missing' && lowered.includes('playwright')) {
    return ['Run npx playwright install chromium in the repository.', 'Restart the controller after installing the browser binary.'];
  }
  if (errorClass === 'policy_denied') return ['Use a narrower safe-summary tool or request an explicit grant before retrying.'];
  if (errorClass === 'authorization_required') return ['Open Approval Inbox and approve the specific action with the required confirmation level.'];
  if (errorClass === 'platform_blocked') return ['Do not retry the same opaque call. Use parameterized safe tools or patch handoff.'];
  if (errorClass === 'runtime_error') return ['Run capability recovery probe and apply the suggested local recovery action.'];
  return ['Open the bounded job details only if the safe summary is insufficient.'];
}

function enrichDelegatedDigest(
  job: ExecutionJob,
  digest: ReturnType<typeof buildJobOperationDigest>,
  repoRoot?: string,
): ReturnType<typeof buildJobOperationDigest> {
  if (!repoRoot) return digest;
  const childReference = digest.childReference ?? childReferenceFromJob(job);
  if (!hasDurableChildReference(childReference) || !childReference) return digest;
  if (!(isAgentDelegationOperation(job.payload.operation) || job.type === 'agent-run' || job.type === 'dispatch-task')) {
    return digest;
  }
  try {
    // Lazy require keeps summary module free of circular import with job-store.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLocalBridgeJob } = require('../../cli/local-bridge/job-store') as typeof import('../../cli/local-bridge/job-store');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAgentJob } = require('../../cli/agent-jobs/job-manager') as typeof import('../../cli/agent-jobs/job-manager');
    let childLocalJobStatus = digest.childLocalJobStatus;
    let childRunStatus = digest.childRunStatus;
    if (childReference.localJobId) {
      try {
        const localJob = getLocalBridgeJob(repoRoot, childReference.localJobId);
        childLocalJobStatus = localJob.status;
        if (localJob.runId) childReference.runId = localJob.runId;
        if (localJob.issueId) childReference.issueId = localJob.issueId;
        if (localJob.taskId) childReference.taskId = localJob.taskId;
      } catch {
        // Local Job may have been cleaned; Run remains the authority when present.
      }
    }
    if (childReference.runId) {
      try {
        const run = getAgentJob(repoRoot, childReference.runId);
        childRunStatus = run.status;
      } catch {
        // Run lookup failures leave the parent Job status authoritative for itself.
      }
    }
    const summary = childRunStatus
      ? `父 Job 已委派；子 Run ${childReference.runId} 状态 ${childRunStatus}。`
      : childLocalJobStatus
        ? `父 Job 已委派；Local Job ${childReference.localJobId} 状态 ${childLocalJobStatus}。`
        : digest.summary;
    return {
      ...digest,
      childReference,
      childRunStatus,
      childLocalJobStatus,
      delegationAccepted: true,
      summary,
      // Parent terminal success never means the child Task passed acceptance.
      resultAccepted: digest.terminal ? false : null,
    };
  } catch {
    return digest;
  }
}

export function summarizeExecutionJobForMcp(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  const payloadArguments = job.payload.arguments && typeof job.payload.arguments === 'object'
    ? Object.keys(job.payload.arguments as Record<string, unknown>).slice(0, 20)
    : undefined;
  const replacements = repoRoot ? [repoRoot] : [];
  const resultPreview = job.result !== undefined ? jsonPreview(job.result, 320, replacements) : undefined;
  const artifactRefs = collectArtifactRefs(job.result, job.error?.details);
  const evidenceIds = job.evidenceIds.slice(-20);
  const errorDetailsAvailable = job.error?.details !== undefined;
  const rawDigest = enrichDelegatedDigest(job, buildJobOperationDigest(job), repoRoot);
  const digest = JSON.parse(
    redactMcpText(scrubPathText(JSON.stringify(rawDigest), replacements)).text,
  ) as ReturnType<typeof buildJobOperationDigest>;
  return {
    jobId: job.jobId,
    repoId: job.repoId,
    checkoutId: job.checkoutId,
    type: job.type,
    status: job.status,
    phase: digest.phase,
    statusLabel: digest.statusLabel,
    summary: digest.summary,
    terminal: digest.terminal,
    errorClass: digest.errorClass,
    errorMessage: digest.errorMessage ?? (job.error?.message ? sanitizeMessage(job.error.message, replacements) : undefined),
    changedFiles: digest.changedFiles,
    suggestedNextActions: digest.suggestedNextActions,
    childReference: digest.childReference,
    childRunStatus: digest.childRunStatus,
    childLocalJobStatus: digest.childLocalJobStatus,
    delegationAccepted: digest.delegationAccepted,
    digest,
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
    resourceClaims: job.resourceClaims.map((claim) => ({
      resourceKey: redactMcpText(scrubPathText(claim.resourceKey, replacements)).text,
      mode: claim.mode,
    })),
    dependencyCount: job.dependencies.length,
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
    evidenceCount: job.evidenceIds.length,
    evidenceIds,
    evidenceIdsTruncated: job.evidenceIds.length > evidenceIds.length,
    ...(artifactRefs.length ? { artifactRefs } : {}),
    detailPointers: {
      includeEvents: `Call get_job with job_id=${job.jobId} and include_events=true for bounded event previews.`,
      ...(artifactRefs.length ? { artifacts: artifactRefs } : {}),
      evidenceIds,
      rawJobStateReturned: false,
    },
    outcome: job.outcome ? {
      infrastructureError: job.outcome.infrastructureError ? {
        code: job.outcome.infrastructureError.code,
        message: sanitizeMessage(job.outcome.infrastructureError.message, replacements),
      } : undefined,
    } : undefined,
    result: resultPreview
      ? {
        preview: resultPreview.preview,
        truncated: resultPreview.truncated,
        byteLength: resultPreview.byteLength,
        next: artifactRefs.length ? 'Call get_artifact with a listed artifactId for bounded content.' : 'Result is returned only as a bounded preview in job summaries.',
      }
      : undefined,
    error: job.error || digest.errorMessage
      ? {
        code: job.error?.code || digest.errorClass || 'UNKNOWN_FAILURE',
        message: job.error?.message
          ? sanitizeMessage(job.error.message, replacements)
          : (digest.errorMessage || '任务失败，但未提供详细错误信息。'),
        class: digest.errorClass || classifyError(job.error?.message || digest.errorMessage || ''),
        retryable: job.error?.retryable ?? false,
        detailsAvailable: errorDetailsAvailable,
        detailsSuppressed: errorDetailsAvailable && artifactRefs.length === 0,
        ...(artifactRefs.length ? { artifactRefs } : {}),
      }
      : undefined,
  };
}

export function summarizeJobResultForLowInterception(job: ExecutionJob): SafeJobResultSummary {
  const message = job.error?.message ?? (job.outcome && typeof job.outcome === 'object' ? JSON.stringify(job.outcome) : '');
  const errorClass = message ? classifyError(message) : undefined;
  const payloadArguments = job.payload.arguments && typeof job.payload.arguments === 'object'
    ? job.payload.arguments as Record<string, unknown>
    : {};
  const pluginId = typeof payloadArguments.pluginId === 'string' ? payloadArguments.pluginId : undefined;
  const actionId = typeof payloadArguments.actionId === 'string' ? payloadArguments.actionId : undefined;
  const resultPreview = pluginId === 'browser'
    ? safeBrowserResultPreview(actionId, job.result)
    : undefined;
  const artifactRefs = collectArtifactRefs(job.result, job.error?.details);
  return {
    jobId: job.jobId,
    repoId: job.repoId,
    status: job.status,
    type: job.type,
    operation: job.payload.operation,
    ...(pluginId || actionId ? { plugin: { pluginId, actionId } } : {}),
    safeError: message && errorClass ? {
      code: job.error?.code,
      class: errorClass,
      retryable: job.error?.retryable,
      message: sanitizeMessage(message),
      suggestedFixes: suggestedFixesFor(message, errorClass),
    } : undefined,
    resultAvailable: job.result !== undefined,
    ...(resultPreview ? { resultPreview } : {}),
    evidenceIds: [...job.evidenceIds],
    ...(artifactRefs.length ? { artifactRefs, detailPointers: { artifacts: artifactRefs, rawJobStateReturned: false } } : {}),
    redaction: {
      rawStdoutReturned: false,
      rawStderrReturned: false,
      rawPathsReturned: false,
      rawSecretsReturned: false,
    },
  };
}
