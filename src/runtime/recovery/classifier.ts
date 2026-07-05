import type { RecoveryClass } from './types';

const PLATFORM_BLOCK_PATTERNS = [
  /blocked by openai/i,
  /safety checks/i,
  /tool call was blocked/i,
  /平台.*拦截/i,
  /安全检查.*屏蔽/i,
];

const AUTH_PATTERNS = [
  /authorizationrequired/i,
  /oauth authorization required/i,
  /auth_required/i,
  /token refresh/i,
  /access token/i,
  /client id and client secret/i,
  /re-authorization required/i,
];

const POLICY_PATTERNS = [
  /policy denied/i,
  /policy_denied/i,
  /not allowed/i,
  /forbidden by policy/i,
  /confirmation required/i,
  /denied/i,
];

const AGENT_RUNTIME_PATTERNS = [
  /transport channel closed/i,
  /worker quit/i,
  /failed to initialize mcp/i,
  /timeout waiting for child process/i,
  /mcp startup failed/i,
];

const SOURCE_DEFECT_PATTERNS = [
  /typeerror/i,
  /referenceerror/i,
  /cannot read properties/i,
  /assertion failed/i,
  /identity mismatch/i,
];

export function classifyFailure(message: string | undefined): RecoveryClass {
  const text = message ?? '';
  if (!text.trim()) return 'unknown';
  if (PLATFORM_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) return 'platform_blocked';
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) return 'auth_required';
  if (POLICY_PATTERNS.some((pattern) => pattern.test(text))) return 'policy_denied';
  if (AGENT_RUNTIME_PATTERNS.some((pattern) => pattern.test(text))) return 'agent_runtime_failure';
  if (SOURCE_DEFECT_PATTERNS.some((pattern) => pattern.test(text))) return 'source_defect_suspected';
  return 'unknown';
}

export function dominantRecoveryClass(classes: readonly RecoveryClass[]): RecoveryClass {
  for (const value of [
    'platform_blocked',
    'auth_required',
    'dirty_worktree_conflict',
    'policy_denied',
    'source_defect_suspected',
    'stale_runtime_state',
    'local_recoverable',
    'agent_runtime_failure',
    'plugin_configuration_error',
    'user_action_required',
  ] as const) {
    if (classes.includes(value)) return value;
  }
  return 'unknown';
}
