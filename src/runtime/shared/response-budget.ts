/**
 * Response size budgets for MCP / Job / Artifact default surfaces.
 *
 * Defaults stay compact so callers get stdout/summary without nested
 * controller/repository/runtime state. Full detail stays behind explicit
 * detail/artifact/result APIs.
 */

export const RESPONSE_BUDGET = {
  /** Default successful tool/job summary target. */
  successBytes: 16 * 1024,
  /** Default failure summary target (includes bounded stderr). */
  failureBytes: 32 * 1024,
  /** Inline stdout/stderr when under this size. */
  inlineOutputBytes: 8 * 1024,
  /** Preview window for externalized payloads. */
  previewBytes: 2 * 1024,
  /** Cap for error.message text (never dump full JSON responses). */
  errorMessageChars: 800,
  /** Max artifact content returned by default get_artifact. */
  artifactDefaultBytes: 64 * 1024,
  /** Absolute upper bound for a single artifact read window. */
  artifactMaxBytes: 512 * 1024,
} as const;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function boundUtf8(value: string, maxBytes: number): { text: string; truncated: boolean; byteLength: number } {
  const byteLength = utf8ByteLength(value);
  if (byteLength <= maxBytes) return { text: value, truncated: false, byteLength };
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return { text: `${value.slice(0, Math.max(0, end - 3))}...`, truncated: true, byteLength };
}

/** Prevent recursive JSON dumps inside error.message. */
export function compactErrorMessage(error: unknown, maxChars = RESPONSE_BUDGET.errorMessageChars): string {
  if (error instanceof Error) {
    const message = error.message?.trim() || error.name || 'Error';
    if (looksLikeSerializedJson(message)) {
      return boundText(summarizeSerializedJson(message), maxChars);
    }
    return boundText(message, maxChars);
  }
  if (typeof error === 'string') {
    if (looksLikeSerializedJson(error)) return boundText(summarizeSerializedJson(error), maxChars);
    return boundText(error, maxChars);
  }
  try {
    const serialized = JSON.stringify(error);
    if (!serialized) return 'unknown error';
    if (serialized.length <= maxChars) return serialized;
    return boundText(summarizeSerializedJson(serialized), maxChars);
  } catch {
    return 'unknown error';
  }
}

function looksLikeSerializedJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  // Heuristic: large structured dumps should never become error.message.
  return trimmed.length > 240 || /"jobId"|"structuredContent"|"runtimeStorage"|"repository"\s*:/.test(trimmed);
}

function summarizeSerializedJson(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return boundText(value, 200);
    const record = parsed as Record<string, unknown>;
    const code = typeof record.code === 'string'
      ? record.code
      : (record.error && typeof record.error === 'object' && typeof (record.error as { code?: unknown }).code === 'string'
        ? String((record.error as { code: string }).code)
        : undefined);
    const message = typeof record.message === 'string'
      ? record.message
      : (record.error && typeof record.error === 'object' && typeof (record.error as { message?: unknown }).message === 'string'
        ? String((record.error as { message: string }).message)
        : undefined);
    const jobId = typeof record.jobId === 'string' ? record.jobId : undefined;
    const parts = [
      code ? `code=${code}` : undefined,
      message ? boundText(message, 200) : undefined,
      jobId ? `jobId=${jobId}` : undefined,
      `jsonBytes=${utf8ByteLength(value)}`,
    ].filter(Boolean);
    return parts.join('; ') || `structured error (${utf8ByteLength(value)} bytes)`;
  } catch {
    return `structured error (${utf8ByteLength(value)} bytes)`;
  }
}

export function compactJsonValue(
  value: unknown,
  budgetBytes = RESPONSE_BUDGET.successBytes,
): { value: unknown; byteLength: number; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return { value: { error: 'UNSERIALIZABLE_VALUE' }, byteLength: 0, truncated: true };
  }
  const byteLength = utf8ByteLength(serialized);
  if (byteLength <= budgetBytes) return { value, byteLength, truncated: false };
  return {
    value: {
      truncated: true,
      byteLength,
      preview: boundUtf8(serialized, Math.min(RESPONSE_BUDGET.previewBytes, budgetBytes)).text,
      message: 'Payload exceeded default response budget. Use detail/artifact/result APIs for full content.',
    },
    byteLength,
    truncated: true,
  };
}

export function compactCommandOutput(
  stdout: string | undefined,
  stderr: string | undefined,
  options: { ok?: boolean; maxInlineBytes?: number } = {},
): {
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  externalized?: boolean;
} {
  const maxInline = options.maxInlineBytes ?? RESPONSE_BUDGET.inlineOutputBytes;
  const out: ReturnType<typeof compactCommandOutput> = {};
  if (typeof stdout === 'string') {
    const bound = boundUtf8(stdout, maxInline);
    out.stdout = bound.text;
    out.stdoutBytes = bound.byteLength;
    if (bound.truncated) out.stdoutTruncated = true;
  }
  if (typeof stderr === 'string' && stderr.length > 0) {
    const failureBudget = options.ok === false
      ? Math.max(maxInline, RESPONSE_BUDGET.failureBytes / 2)
      : maxInline;
    const bound = boundUtf8(stderr, failureBudget);
    out.stderr = bound.text;
    out.stderrBytes = bound.byteLength;
    if (bound.truncated) out.stderrTruncated = true;
  }
  out.externalized = Boolean(out.stdoutTruncated || out.stderrTruncated);
  return out;
}

export function compactRepositoryRef(input: {
  repoId: string;
  checkoutId?: string;
  displayName?: string;
  defaultBranch?: string;
}): Record<string, unknown> {
  return {
    repoId: input.repoId,
    ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
  };
}

export function compactRuntimeStorageRef(input: {
  readyForExecution?: boolean;
  usesStableRoot?: boolean;
  warningCount?: number;
  warnings?: string[];
}): Record<string, unknown> {
  const warnings = (input.warnings ?? []).slice(0, 3).map((entry) => boundText(entry, 160));
  return {
    readyForExecution: input.readyForExecution === true,
    usesStableRoot: input.usesStableRoot === true,
    warningCount: input.warningCount ?? warnings.length,
    ...(warnings.length ? { warnings } : {}),
  };
}

export function compactRoutingSummary(input: {
  path?: string;
  mode?: string;
  reasons?: string[];
}): Record<string, unknown> {
  return {
    path: input.path ?? input.mode ?? 'unknown',
    ...(input.mode && input.mode !== input.path ? { mode: input.mode } : {}),
    reasons: (input.reasons ?? []).slice(0, 8),
  };
}

export function artifactRef(input: {
  artifactId: string;
  artifactKind?: string;
  byteLength?: number;
  repoId?: string;
  jobId?: string;
}): Record<string, unknown> {
  return {
    referenceType: 'artifact',
    artifactId: input.artifactId,
    ...(input.artifactKind ? { artifactKind: input.artifactKind } : {}),
    ...(typeof input.byteLength === 'number' ? { byteLength: input.byteLength } : {}),
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    next: input.repoId
      ? `Call get_artifact with repo_id=${input.repoId} and artifact_id=${input.artifactId}.`
      : `Call get_artifact with artifact_id=${input.artifactId}.`,
  };
}

export function evidenceRef(input: {
  evidenceId: string;
  repoId?: string;
  jobId?: string;
}): Record<string, unknown> {
  return {
    referenceType: 'evidence',
    evidenceId: input.evidenceId,
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    note: 'evidenceId is not an artifactId. Use evidenceIds for audit; use artifactRefs/artifactId for command output.',
    next: input.repoId
      ? `Evidence metadata is available via job summary evidenceIds. For output content call get_artifact with an artifactId (ART-...), not ${input.evidenceId}.`
      : 'Evidence metadata is available via job summary evidenceIds. For output content use artifactId (ART-...).',
  };
}
