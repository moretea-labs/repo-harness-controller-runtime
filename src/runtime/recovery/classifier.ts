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

const RUNTIME_STORAGE_PATTERNS = [
  /runtime_storage_not_ready/i,
  /runtime storage.*not ready/i,
  /readyforexecution.*false/i,
  /storage relocation/i,
  /runtime storage can be relocated/i,
];

const LOCAL_JOBS_UNREADABLE_PATTERNS = [
  /unreadable local jobs?/i,
  /malformed local jobs?/i,
  /missing.*local jobs?.*job\.json/i,
  /local jobs?.*metadata.*unreadable/i,
];

const LOCAL_JOBS_LEGACY_ACTIVE_PATTERNS = [
  /legacy-active/i,
  /active or unreadable local jobs?/i,
  /local-jobs: active/i,
  /local jobs must finish/i,
  /local jobs?.*finish before runtime storage/i,
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
  if (LOCAL_JOBS_LEGACY_ACTIVE_PATTERNS.some((pattern) => pattern.test(text))) return 'local_jobs_legacy_active';
  if (LOCAL_JOBS_UNREADABLE_PATTERNS.some((pattern) => pattern.test(text))) return 'local_jobs_unreadable';
  if (RUNTIME_STORAGE_PATTERNS.some((pattern) => pattern.test(text))) return 'runtime_storage_not_ready';
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
    'local_jobs_legacy_active',
    'local_jobs_unreadable',
    'runtime_storage_not_ready',
    'local_jobs_reconciliation_required',
    'maintenance_executor_required',
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
