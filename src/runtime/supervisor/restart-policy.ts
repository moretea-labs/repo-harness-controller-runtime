import type { RestartBudgetRecord, SupervisorComponentName } from './types';

export const DEFAULT_RESTART_POLICY = {
  probeIntervalMs: 5_000,
  unhealthyWindowMs: 45_000,
  restartBudget: 5,
  budgetWindowMs: 10 * 60_000,
  backoffMs: [1_000, 2_000, 5_000, 15_000, 30_000],
  stableResetWindowMs: 15 * 60_000,
  jitterRatio: 0.2,
} as const;

export interface RestartDecision {
  allowed: boolean;
  delayMs: number;
  reason?: 'restart_budget_exhausted' | 'backoff';
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function restartBudgetKey(component: SupervisorComponentName, generation?: string): string {
  return `${component}:${generation ?? 'unknown'}`;
}

export function newRestartBudgetRecord(
  component: SupervisorComponentName,
  generation: string | undefined,
  now = new Date(),
): RestartBudgetRecord {
  return {
    key: restartBudgetKey(component, generation),
    component,
    ...(generation ? { generation } : {}),
    windowStartedAt: now.toISOString(),
    attempts: 0,
    consecutiveFailures: 0,
    lockedOut: false,
    autoRollbackCount: 0,
  };
}

export function decideRestart(
  record: RestartBudgetRecord,
  now = new Date(),
  policy = DEFAULT_RESTART_POLICY,
  random = 0.5,
): RestartDecision {
  const current = now.getTime();
  const windowStart = timestamp(record.windowStartedAt) ?? current;
  const elapsed = Math.max(0, current - windowStart);
  const attempts = elapsed > policy.budgetWindowMs ? 0 : record.attempts;
  if (record.lockedOut || attempts >= policy.restartBudget) {
    return { allowed: false, delayMs: 0, reason: 'restart_budget_exhausted' };
  }
  const lastRestartAt = timestamp(record.lastRestartAt);
  const backoffIndex = Math.min(record.consecutiveFailures, policy.backoffMs.length - 1);
  const baseDelay = policy.backoffMs[backoffIndex] ?? 0;
  const jitter = Math.round(baseDelay * policy.jitterRatio * Math.max(-1, Math.min(1, random * 2 - 1)));
  const availableAt = (lastRestartAt ?? 0) + baseDelay + jitter;
  if (lastRestartAt !== undefined && current < availableAt) {
    return { allowed: false, delayMs: availableAt - current, reason: 'backoff' };
  }
  return { allowed: true, delayMs: 0 };
}

export function recordRestart(
  record: RestartBudgetRecord,
  now = new Date(),
): RestartBudgetRecord {
  const current = now.getTime();
  const windowStart = timestamp(record.windowStartedAt);
  const resetWindow = windowStart === undefined || current - windowStart > DEFAULT_RESTART_POLICY.budgetWindowMs;
  return {
    ...record,
    windowStartedAt: resetWindow ? now.toISOString() : record.windowStartedAt,
    attempts: resetWindow ? 1 : record.attempts + 1,
    consecutiveFailures: record.consecutiveFailures,
    lastRestartAt: now.toISOString(),
    lockedOut: false,
  };
}

export function recordFailure(record: RestartBudgetRecord, reason: string, now = new Date()): RestartBudgetRecord {
  return {
    ...record,
    consecutiveFailures: record.consecutiveFailures + 1,
    lastFailureAt: now.toISOString(),
    reason: reason.replace(/\s+/g, ' ').slice(0, 500),
  };
}

export function recordStable(
  record: RestartBudgetRecord,
  now = new Date(),
  policy = DEFAULT_RESTART_POLICY,
): RestartBudgetRecord {
  const stableSince = timestamp(record.stableSinceAt);
  if (stableSince === undefined) return { ...record, stableSinceAt: now.toISOString() };
  if (now.getTime() - stableSince < policy.stableResetWindowMs) return record;
  return {
    ...record,
    attempts: 0,
    consecutiveFailures: 0,
    windowStartedAt: now.toISOString(),
    stableSinceAt: now.toISOString(),
    lockedOut: false,
    reason: undefined,
  };
}

export function lockout(record: RestartBudgetRecord, reason: string, now = new Date()): RestartBudgetRecord {
  return {
    ...record,
    lockedOut: true,
    lastFailureAt: now.toISOString(),
    reason: reason.replace(/\s+/g, ' ').slice(0, 500),
  };
}
