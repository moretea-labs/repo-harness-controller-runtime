/**
 * Bounded retries for idempotent / readonly transport failures only.
 * Mutations must not use this without an explicit idempotency key.
 */

export type RetryableTransportStatus = 408 | 429 | 502 | 503 | 504;

export interface IdempotentRetryOptions {
  /** Max attempts including the first call. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms. Default 50. */
  baseDelayMs?: number;
  /** Max backoff in ms. Default 500. */
  maxDelayMs?: number;
  /** When false, never retry. Default true. */
  enabled?: boolean;
  /** Optional sleep implementation (tests inject). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional clock (tests inject). */
  now?: () => number;
}

export interface RetryClassification {
  retryable: boolean;
  reason: string;
  status?: number;
  code?: string;
}

const RETRYABLE_STATUSES = new Set<number>([408, 429, 502, 503, 504]);
const RETRYABLE_CODES = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_SOCKET|FETCH_FAILED|server_busy|session_capacity|gateway_unavailable|MCP_REQUEST_FAILED/i;

export function classifyTransportFailure(error: unknown, status?: number): RetryClassification {
  if (typeof status === 'number' && RETRYABLE_STATUSES.has(status)) {
    return {
      retryable: true,
      reason: `http_${status}`,
      status,
      code: status === 502 ? 'GATEWAY_BAD_GATEWAY' : status === 503 ? 'SERVICE_UNAVAILABLE' : `HTTP_${status}`,
    };
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (RETRYABLE_CODES.test(message) || /(?:\b502\b|\b503\b|\b429\b|bad gateway|temporarily unavailable)/i.test(message)) {
    return {
      retryable: true,
      reason: 'transient_transport',
      status,
      code: 'TRANSIENT_TRANSPORT',
    };
  }
  return { retryable: false, reason: 'non_retryable', status };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an idempotent async operation with short exponential backoff.
 * Only retries when classifier says retryable; never for mutation paths.
 */
export async function withIdempotentRetry<T>(
  operation: () => Promise<T>,
  options: IdempotentRetryOptions & {
    /** Caller must declare the call is safe to retry. */
    idempotent: boolean;
    isRetryableResult?: (value: T) => RetryClassification | undefined;
  },
): Promise<T> {
  if (!options.idempotent || options.enabled === false) {
    return operation();
  }
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 4));
  const baseDelayMs = Math.max(10, options.baseDelayMs ?? 50);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 500);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await operation();
      if (options.isRetryableResult && attempt < maxAttempts) {
        const classification = options.isRetryableResult(value);
        if (classification?.retryable) {
          const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          await sleep(delay);
          continue;
        }
      }
      return value;
    } catch (error) {
      lastError = error;
      const classification = classifyTransportFailure(error);
      if (!classification.retryable || attempt >= maxAttempts) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'retry_exhausted'));
}

/**
 * Fetch wrapper for idempotent GET/HEAD (and POST only when caller marks idempotent).
 * Does not retry non-idempotent methods unless `idempotent: true` is explicit.
 */
export async function fetchIdempotent(
  input: string | URL,
  init: RequestInit & { idempotent?: boolean } = {},
  options: IdempotentRetryOptions = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const idempotent = init.idempotent === true || method === 'GET' || method === 'HEAD';
  const { idempotent: _omit, ...fetchInit } = init;
  return withIdempotentRetry(
    async () => {
      const response = await fetch(input, fetchInit);
      if (RETRYABLE_STATUSES.has(response.status) && idempotent) {
        // Consume body lightly so the connection can close; throw for retry.
        try { await response.arrayBuffer(); } catch { /* ignore */ }
        const error = new Error(`HTTP_${response.status}: transient gateway/transport failure`);
        (error as Error & { status?: number }).status = response.status;
        throw error;
      }
      return response;
    },
    { ...options, idempotent },
  );
}
