const DEFAULT_ENDPOINT = 'https://api.chatgpt.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_TRANSPORT_ATTEMPTS = 3;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;

export interface WorkspaceAgentTriggerInput {
  agentId: string;
  input: string;
  conversationKey?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface WorkspaceAgentTriggerResult {
  accepted: true;
  status: 202;
  agentId: string;
  conversationKey?: string;
  idempotencyKey?: string;
  transportAttempts: number;
  triggeredAt: string;
}

export interface WorkspaceAgentTriggerOptions {
  fetchImpl?: typeof fetch;
  token?: string;
  endpoint?: string;
  now?: () => Date;
  sleep?: (delayMs: number) => Promise<void>;
  maxTransportAttempts?: number;
}

function boundedText(value: string, field: string, maxBytes: number): string {
  const text = value.trim();
  if (!text) throw new Error(`WORKSPACE_AGENT_${field.toUpperCase()}_REQUIRED`);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`WORKSPACE_AGENT_${field.toUpperCase()}_TOO_LARGE: maximum ${maxBytes} bytes`);
  }
  return text;
}

function accessToken(explicit?: string): string {
  const token = explicit?.trim()
    || process.env.OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN?.trim()
    || process.env.CHATGPT_WORKSPACE_AGENT_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('WORKSPACE_AGENT_TOKEN_REQUIRED: set OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN');
  return token;
}

function timeoutMs(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(60_000, Math.trunc(value!)));
}

function transportAttempts(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRANSPORT_ATTEMPTS;
  return Math.max(1, Math.min(5, Math.trunc(value!)));
}

async function boundedErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return Buffer.from(text, 'utf8').subarray(0, MAX_ERROR_BYTES).toString('utf8').trim();
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delayMs(attempt: number): number {
  return Math.min(2_000, 250 * (2 ** Math.max(0, attempt - 1)));
}

export async function triggerWorkspaceAgent(
  request: WorkspaceAgentTriggerInput,
  options: WorkspaceAgentTriggerOptions = {},
): Promise<WorkspaceAgentTriggerResult> {
  const agentId = boundedText(request.agentId, 'agent_id', 256);
  if (!/^agtch_[A-Za-z0-9_-]+$/.test(agentId)) {
    throw new Error('WORKSPACE_AGENT_ID_INVALID: expected a published API trigger id in agtch_... format');
  }
  const input = boundedText(request.input, 'input', MAX_INPUT_BYTES);
  const conversationKey = request.conversationKey?.trim();
  if (conversationKey && Buffer.byteLength(conversationKey, 'utf8') > 512) {
    throw new Error('WORKSPACE_AGENT_CONVERSATION_KEY_TOO_LARGE: maximum 512 bytes');
  }
  const idempotencyKey = request.idempotencyKey?.trim();
  if (idempotencyKey && Buffer.byteLength(idempotencyKey, 'utf8') > 512) {
    throw new Error('WORKSPACE_AGENT_IDEMPOTENCY_KEY_TOO_LARGE: maximum 512 bytes');
  }

  const token = accessToken(options.token);
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((value: number) => new Promise((resolve) => setTimeout(resolve, value)));
  const maximumAttempts = transportAttempts(options.maxTransportAttempts);
  const deadline = Date.now() + timeoutMs(request.timeoutMs);
  let lastDefiniteFailure: Error | undefined;
  let lastAmbiguousFailure: Error | undefined;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const perAttemptTimeout = Math.max(250, Math.min(10_000, remaining));
    const timer = setTimeout(() => controller.abort(), perAttemptTimeout);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${endpoint}/v1/workspace_agents/${encodeURIComponent(agentId)}/trigger`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify({
          input,
          ...(conversationKey ? { conversation_key: conversationKey } : {}),
        }),
      });
      if (response.status === 202) {
        return {
          accepted: true,
          status: 202,
          agentId,
          ...(conversationKey ? { conversationKey } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          transportAttempts: attempt,
          triggeredAt: (options.now ?? (() => new Date()))().toISOString(),
        };
      }
      const body = await boundedErrorBody(response);
      lastDefiniteFailure = new Error(`WORKSPACE_AGENT_HTTP_${response.status}: ${body || response.statusText || 'trigger rejected'}`);
      if (!retryableStatus(response.status) || attempt >= maximumAttempts) throw lastDefiniteFailure;
    } catch (error) {
      if (error === lastDefiniteFailure) throw error;
      const ambiguous = error instanceof Error && error.name === 'AbortError'
        ? new Error('WORKSPACE_AGENT_OUTCOME_AMBIGUOUS: trigger request timed out before a durable response')
        : new Error(`WORKSPACE_AGENT_OUTCOME_AMBIGUOUS: ${error instanceof Error ? error.message : String(error)}`);
      lastAmbiguousFailure = ambiguous;
      if (attempt >= maximumAttempts) throw ambiguous;
    } finally {
      clearTimeout(timer);
    }
    const backoff = Math.min(delayMs(attempt), Math.max(0, deadline - Date.now()));
    if (backoff > 0) await sleep(backoff);
  }

  if (lastAmbiguousFailure) throw lastAmbiguousFailure;
  if (lastDefiniteFailure) throw lastDefiniteFailure;
  throw new Error('WORKSPACE_AGENT_OUTCOME_AMBIGUOUS: trigger timeout budget exhausted');
}
