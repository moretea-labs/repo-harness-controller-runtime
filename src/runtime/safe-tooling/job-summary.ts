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

function safeString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = sanitizeMessage(value);
  return sanitized.length > maxChars ? sanitized.slice(0, maxChars) : sanitized;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
  const payload = objectValue(result);
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
    redaction: {
      rawStdoutReturned: false,
      rawStderrReturned: false,
      rawPathsReturned: false,
      rawSecretsReturned: false,
    },
  };
}
