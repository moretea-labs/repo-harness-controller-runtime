/**
 * Shared composite-tool response envelope.
 * First-failure diagnosis must be visible without get_job/get_artifact follow-ups.
 */

export type CompositeStatus = 'succeeded' | 'failed' | 'running' | 'partial';

export interface CompositeToolResult {
  status: CompositeStatus;
  phase: string;
  summary: string;
  failedCheck?: string;
  exitCode?: number;
  changedFiles?: string[];
  keyOutput: string;
  evidenceRefs: string[];
  retryable: boolean;
  nextAction: string;
  /** Structured extras for callers that understand the operation. */
  details?: Record<string, unknown>;
}

const KEY_OUTPUT_MAX_CHARS = 4_000;
const SENSITIVE = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi,
  /passphrase["']?\s*[:=]\s*["']?[^\s"']+/gi,
  /REPO_HARNESS_[A-Z0-9_]*TOKEN[A-Z0-9_]*\s*=\s*\S+/gi,
  /sk-[A-Za-z0-9]{20,}/g,
];

export function redactSensitiveText(text: string): string {
  let value = text;
  for (const pattern of SENSITIVE) {
    value = value.replace(pattern, '[REDACTED]');
  }
  return value;
}

export function boundKeyOutput(text: string, maxChars = KEY_OUTPUT_MAX_CHARS): string {
  const redacted = redactSensitiveText(text).replace(/\s+$/g, '');
  if (redacted.length <= maxChars) return redacted;
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 32;
  return `${redacted.slice(0, head)}\n...[truncated ${redacted.length - maxChars} chars]...\n${redacted.slice(-Math.max(tail, 0))}`;
}

export function usefulTail(stdout: string, stderr: string, maxChars = 1_500): string {
  const combined = [stderr, stdout].filter((part) => part?.trim()).join('\n---\n');
  if (!combined.trim()) return '';
  const lines = combined.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^\s*#/.test(trimmed)) return false;
    return true;
  });
  const slice = lines.slice(-40).join('\n');
  return boundKeyOutput(slice, maxChars);
}

export function compositeSucceeded(input: {
  phase: string;
  summary: string;
  changedFiles?: string[];
  keyOutput?: string;
  evidenceRefs?: string[];
  nextAction?: string;
  details?: Record<string, unknown>;
  exitCode?: number;
}): CompositeToolResult {
  return {
    status: 'succeeded',
    phase: input.phase,
    summary: input.summary,
    exitCode: input.exitCode ?? 0,
    changedFiles: input.changedFiles,
    keyOutput: boundKeyOutput(input.keyOutput ?? input.summary),
    evidenceRefs: input.evidenceRefs ?? [],
    retryable: false,
    nextAction: input.nextAction ?? 'continue',
    details: input.details,
  };
}

export function compositeFailed(input: {
  phase: string;
  summary: string;
  failedCheck?: string;
  exitCode?: number;
  changedFiles?: string[];
  keyOutput?: string;
  evidenceRefs?: string[];
  retryable?: boolean;
  nextAction?: string;
  details?: Record<string, unknown>;
}): CompositeToolResult {
  return {
    status: 'failed',
    phase: input.phase,
    summary: input.summary,
    failedCheck: input.failedCheck,
    exitCode: input.exitCode ?? 1,
    changedFiles: input.changedFiles,
    keyOutput: boundKeyOutput(input.keyOutput ?? input.summary),
    evidenceRefs: input.evidenceRefs ?? [],
    retryable: input.retryable ?? true,
    nextAction: input.nextAction ?? 'inspect keyOutput and evidenceRefs, fix, then retry',
    details: input.details,
  };
}

export function compositeRunning(input: {
  phase: string;
  summary: string;
  keyOutput?: string;
  evidenceRefs?: string[];
  nextAction?: string;
  details?: Record<string, unknown>;
}): CompositeToolResult {
  return {
    status: 'running',
    phase: input.phase,
    summary: input.summary,
    keyOutput: boundKeyOutput(input.keyOutput ?? input.summary),
    evidenceRefs: input.evidenceRefs ?? [],
    retryable: false,
    nextAction: input.nextAction ?? 'poll the same durable request id; do not resubmit',
    details: input.details,
  };
}
