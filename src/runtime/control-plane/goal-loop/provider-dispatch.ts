import type { StructuredProviderOutput } from './types';
import { assertNoSecretsInText, redactProviderSummary } from './provider-registry';

export interface ProviderDispatchRequest {
  providerId: string;
  objective: string;
  acceptanceCriteria: string[];
  allowedPaths?: string[];
  constraintsSummary?: string;
  failureContext?: string;
  /** Test / offline structured response injection. */
  mockResponse?: StructuredProviderOutput | 'unsafe' | 'empty';
}

export interface ProviderDispatchResult {
  ok: boolean;
  providerId: string;
  directDispatch: boolean;
  appliedByRepoHarness: true;
  output?: StructuredProviderOutput;
  rejectionReason?: string;
  summary: string;
  /** Real network calls only when REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1 */
  liveCallAttempted: boolean;
}

const LIVE_FLAG = 'REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS';

function isLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_FLAG] === '1' || env[LIVE_FLAG] === 'true';
}

/**
 * Validate structured model output before repo-harness applies anything.
 * Models never mutate files; this only accepts proposals.
 */
export function validateStructuredProviderOutput(
  value: unknown,
): { ok: true; output: StructuredProviderOutput } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'Provider output must be a structured object.' };
  }
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (!summary) {
    return { ok: false, reason: 'Provider output missing summary.' };
  }
  if (!assertNoSecretsInText(summary)) {
    return { ok: false, reason: 'Provider output summary appears to contain secrets.' };
  }

  const changed_files = Array.isArray(record.changed_files)
    ? record.changed_files.map(String).filter(Boolean).slice(0, 50)
    : [];
  const verification_commands = Array.isArray(record.verification_commands)
    ? record.verification_commands.map(String).filter(Boolean).slice(0, 20)
    : [];
  const risk_notes = Array.isArray(record.risk_notes)
    ? record.risk_notes.map(String).filter(Boolean).slice(0, 20)
    : [];

  const proposed_patch = typeof record.proposed_patch === 'string' ? record.proposed_patch : undefined;
  const patch_instructions = typeof record.patch_instructions === 'string' ? record.patch_instructions : undefined;

  if (!proposed_patch && !patch_instructions && changed_files.length === 0) {
    return { ok: false, reason: 'Provider output has no patch, instructions, or changed_files.' };
  }

  if (proposed_patch && /rm\s+-rf\s+[\/~]/.test(proposed_patch)) {
    return { ok: false, reason: 'Unsafe provider output rejected (destructive shell pattern).' };
  }
  if (proposed_patch && !assertNoSecretsInText(proposed_patch)) {
    return { ok: false, reason: 'Provider patch appears to embed secrets.' };
  }

  // Reject obvious direct-execution payloads that try to bypass harness.
  if (record.execute_shell === true || record.mutate_files_directly === true) {
    return { ok: false, reason: 'Provider output attempted direct mutation/execution bypass.' };
  }

  const output: StructuredProviderOutput = {
    summary: summary.slice(0, 2_000),
    proposed_patch: proposed_patch?.slice(0, 50_000),
    patch_instructions: patch_instructions?.slice(0, 10_000),
    changed_files,
    verification_commands,
    risk_notes,
  };

  return { ok: true, output: redactProviderSummary(output) as StructuredProviderOutput };
}

/**
 * Dispatch a bounded request to an invokable provider.
 * Live network calls are disabled unless REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS is set.
 * Grok (and other APIs) return structured proposals; repo-harness applies patches.
 */
export function dispatchProvider(
  request: ProviderDispatchRequest,
  env: NodeJS.ProcessEnv = process.env,
): ProviderDispatchResult {
  if (request.providerId === 'chatgpt_handoff') {
    return {
      ok: false,
      providerId: request.providerId,
      directDispatch: false,
      appliedByRepoHarness: true,
      rejectionReason: 'chatgpt_handoff is handoff-only and cannot be direct-dispatched.',
      summary: 'ChatGPT current conversation is not invokable; create a handoff packet instead.',
      liveCallAttempted: false,
    };
  }

  if (request.mockResponse === 'unsafe') {
    return {
      ok: false,
      providerId: request.providerId,
      directDispatch: true,
      appliedByRepoHarness: true,
      rejectionReason: 'Unsafe provider output rejected (destructive shell pattern).',
      summary: 'Rejected unsafe mock provider output.',
      liveCallAttempted: false,
    };
  }

  if (request.mockResponse === 'empty') {
    return {
      ok: false,
      providerId: request.providerId,
      directDispatch: true,
      appliedByRepoHarness: true,
      rejectionReason: 'Provider output missing summary.',
      summary: 'Rejected empty mock provider output.',
      liveCallAttempted: false,
    };
  }

  if (request.mockResponse && typeof request.mockResponse === 'object') {
    const validated = validateStructuredProviderOutput(request.mockResponse);
    if (!validated.ok) {
      return {
        ok: false,
        providerId: request.providerId,
        directDispatch: true,
        appliedByRepoHarness: true,
        rejectionReason: validated.reason,
        summary: `Rejected mock provider output: ${validated.reason}`,
        liveCallAttempted: false,
      };
    }
    return {
      ok: true,
      providerId: request.providerId,
      directDispatch: true,
      appliedByRepoHarness: true,
      output: validated.output,
      summary: `Mock ${request.providerId} returned structured patch proposal (apply/verify owned by repo-harness).`,
      liveCallAttempted: false,
    };
  }

  // Default offline mock for grok_api when not live — used by tests and dry autonomous ticks.
  if (request.providerId === 'grok_api' && !isLiveEnabled(env)) {
    const mock: StructuredProviderOutput = {
      summary: `Bounded Grok proposal for: ${request.objective.slice(0, 200)}`,
      patch_instructions: 'Apply a minimal fix via repo-harness safe patch APIs; do not execute raw shell from model output.',
      changed_files: (request.allowedPaths ?? []).slice(0, 5),
      verification_commands: ['npm run check:type', 'bun test'],
      risk_notes: ['Model must not mutate files directly', 'repo-harness applies and verifies'],
    };
    const validated = validateStructuredProviderOutput(mock);
    if (!validated.ok) {
      return {
        ok: false,
        providerId: request.providerId,
        directDispatch: true,
        appliedByRepoHarness: true,
        rejectionReason: validated.reason,
        summary: validated.reason,
        liveCallAttempted: false,
      };
    }
    return {
      ok: true,
      providerId: request.providerId,
      directDispatch: true,
      appliedByRepoHarness: true,
      output: validated.output,
      summary: 'Offline Grok structured proposal (live API disabled; set REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1 for real calls).',
      liveCallAttempted: false,
    };
  }

  if (!isLiveEnabled(env)) {
    return {
      ok: false,
      providerId: request.providerId,
      directDispatch: true,
      appliedByRepoHarness: true,
      rejectionReason: 'Live model provider calls disabled.',
      summary: `Provider ${request.providerId} direct dispatch skipped (live calls disabled). Use mockResponse in tests or set ${LIVE_FLAG}=1.`,
      liveCallAttempted: false,
    };
  }

  // Live path intentionally minimal: real HTTP clients can be filled in without
  // changing the policy that repo-harness owns apply/verify.
  return {
    ok: false,
    providerId: request.providerId,
    directDispatch: true,
    appliedByRepoHarness: true,
    rejectionReason: 'Live provider HTTP client not enabled in this build path for safety.',
    summary: `Live dispatch for ${request.providerId} is gated; use offline structured proposals or extend the adapter with explicit policy.`,
    liveCallAttempted: true,
  };
}
