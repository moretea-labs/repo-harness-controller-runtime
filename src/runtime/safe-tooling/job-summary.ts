import type { ExecutionJob } from '../execution/jobs/types';
import type { SafeJobResultSummary } from './types';

type SafeErrorClass = NonNullable<SafeJobResultSummary['safeError']>['class'];

function sanitizeMessage(message: string): string {
  return message
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>')
    .slice(0, 800);
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

export function summarizeJobResultForLowInterception(job: ExecutionJob): SafeJobResultSummary {
  const message = job.error?.message ?? (job.outcome && typeof job.outcome === 'object' ? JSON.stringify(job.outcome) : '');
  const errorClass = message ? classifyError(message) : undefined;
  const payloadArguments = job.payload.arguments && typeof job.payload.arguments === 'object'
    ? job.payload.arguments as Record<string, unknown>
    : {};
  const pluginId = typeof payloadArguments.pluginId === 'string' ? payloadArguments.pluginId : undefined;
  const actionId = typeof payloadArguments.actionId === 'string' ? payloadArguments.actionId : undefined;
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
    evidenceIds: [...job.evidenceIds],
    redaction: {
      rawStdoutReturned: false,
      rawStderrReturned: false,
      rawPathsReturned: false,
      rawSecretsReturned: false,
    },
  };
}
