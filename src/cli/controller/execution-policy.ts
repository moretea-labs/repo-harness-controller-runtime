import type { CleanupEvidence, CompletionReceipt, CompletionResourceBlocker, ControllerTask, IntegrationEvidence, TaskAcceptanceOutcome, TaskAcceptanceResult, TaskRisk, TaskVerification } from './types';

export type TaskExecutionClass =
  | 'read_only'
  | 'low_risk_change'
  | 'medium_risk_change'
  | 'high_risk_change'
  | 'destructive_change';

export type ApprovalRequirement = 'auto' | 'confirm' | 'manual-only';

export interface TaskExecutionPolicy {
  risk: TaskRisk;
  executionClass: TaskExecutionClass;
  approval: ApprovalRequirement;
  requiresScopedPaths: boolean;
  requiresDiffEvidence: boolean;
  requiresAnyVerificationEvidence: boolean;
  requiresAcceptanceEvidence: boolean;
  requiresHumanAcceptance: boolean;
  autoRunDeclaredChecks: boolean;
  autoCompleteAfterSuccessfulRun: boolean;
  warnings: string[];
  sensitivePaths: string[];
  destructiveSignals: string[];
}

export interface CompletionReceiptExpectation {
  issueId?: string;
  taskId?: string;
  runId?: string;
  editSessionId?: string;
  targetBranch?: string;
}

function receiptSourceIdentityComplete(receipt: CompletionReceipt): boolean {
  if (receipt.source === 'direct_edit') return Boolean(receipt.editSessionId?.trim()) && !receipt.runId;
  if (receipt.source === 'isolated_agent_run' || receipt.source === 'workspace_run') return Boolean(receipt.runId?.trim());
  return true;
}

export function completionReceiptComplete(
  receipt: CompletionReceipt | undefined,
  expected: CompletionReceiptExpectation = {},
): receipt is CompletionReceipt {
  return Boolean(receipt
    && receipt.schemaVersion === 1
    && receipt.receiptId.trim()
    && receipt.issueId.trim()
    && receipt.taskId.trim()
    && receipt.targetBranch.trim()
    && receipt.targetRevision.trim()
    && receiptSourceIdentityComplete(receipt)
    && (!expected.issueId || receipt.issueId === expected.issueId)
    && (!expected.taskId || receipt.taskId === expected.taskId)
    && (!expected.runId || receipt.runId === expected.runId)
    && (!expected.editSessionId || receipt.editSessionId === expected.editSessionId)
    && (!expected.targetBranch || receipt.targetBranch === expected.targetBranch)
    && receipt.delivery.status === 'integrated'
    && receipt.delivery.reachable
    && receipt.cleanup.status !== 'blocked'
    && Array.isArray(receipt.cleanup.blockers)
    && receipt.cleanup.blockers.length === 0);
}

function cleanupBlocker(
  code: CompletionResourceBlocker['code'],
  message: string,
  resourceKind: CompletionResourceBlocker['resourceKind'],
  recordedAt: string,
): CompletionResourceBlocker {
  return { code, message, resourceKind, recordedAt };
}

export function cleanupEvidenceResourceBlockers(
  cleanup: CleanupEvidence,
  options: { includeRunTerminal?: boolean } = {},
): CompletionResourceBlocker[] {
  const recordedAt = cleanup.recordedAt || new Date().toISOString();
  const blockers = [...(cleanup.resourceBlockers ?? [])];
  const warningOnlyRetention = (cleanup.maintenanceWarnings?.length ?? 0) > 0 && blockers.length === 0;
  const add = (entry: CompletionResourceBlocker): void => {
    if (!blockers.some((candidate) => candidate.code === entry.code && candidate.resourceKind === entry.resourceKind)) blockers.push(entry);
  };
  if (!cleanup.worktreeRemovedOrNotCreated && !warningOnlyRetention) {
    add(cleanupBlocker('unknown_resource_ownership', 'Worktree removal or absence was not proven.', 'worktree', recordedAt));
  }
  if (!cleanup.branchDeletedOrRetained && !warningOnlyRetention) {
    add(cleanupBlocker('unknown_resource_ownership', 'Temporary branch deletion or retention was not proven.', 'branch', recordedAt));
  }
  if (!cleanup.leasesReleased) add(cleanupBlocker('lease_active', 'Task-owned leases are still active.', 'lease', recordedAt));
  if (!cleanup.editSessionClosedOrNotCreated) add(cleanupBlocker('edit_session_open', 'Task-owned edit session is not closed.', 'edit_session', recordedAt));
  if (!cleanup.noActiveProcess) add(cleanupBlocker('active_write_process', 'Task-owned execution process may still be active.', 'process', recordedAt));
  if (!cleanup.noDirtyDiff) add(cleanupBlocker('dirty_owned_paths', 'Task-owned paths still have uncommitted changes.', 'workspace', recordedAt));
  if (options.includeRunTerminal !== false && !cleanup.runTerminal) {
    add(cleanupBlocker('run_not_terminal', 'Task-owned Run has not reached a terminal state.', 'process', recordedAt));
  }
  return blockers;
}

function cleanupEvidenceHasOnlyMaintenanceWarnings(cleanup: CleanupEvidence): boolean {
  return Boolean(
    (cleanup.maintenanceWarnings?.length ?? 0) > 0
    && cleanupEvidenceResourceBlockers(cleanup).length === 0
    && cleanup.leasesReleased
    && cleanup.runTerminal
    && cleanup.editSessionClosedOrNotCreated
    && cleanup.noActiveProcess
    && cleanup.noDirtyDiff,
  );
}

export function completionEvidenceComplete(
  verification: TaskVerification | undefined,
  expected: CompletionReceiptExpectation = {},
): verification is TaskVerification & {
  integrationEvidence?: IntegrationEvidence;
  cleanupEvidence?: CleanupEvidence;
  completionReceipt?: CompletionReceipt;
} {
  const expectedReceipt = { ...expected, runId: expected.runId ?? verification?.runId };
  if (completionReceiptComplete(verification?.completionReceipt, expectedReceipt)) return true;
  const runId = verification?.runId;
  const integration = verification?.integrationEvidence;
  const cleanup = verification?.cleanupEvidence;
  return Boolean(runId
    && (!expected.runId || runId === expected.runId)
    && integration?.runId === runId
    && cleanup?.runId === runId
    && integration.reachable
    && integration.targetBranch.trim()
    && integration.targetRevision.trim()
    && (!expected.targetBranch || integration.targetBranch === expected.targetBranch)
    && (cleanup.worktreeRemovedOrNotCreated || cleanupEvidenceHasOnlyMaintenanceWarnings(cleanup))
    && (cleanup.branchDeletedOrRetained || cleanupEvidenceHasOnlyMaintenanceWarnings(cleanup))
    && cleanup.leasesReleased
    && cleanup.runTerminal
    && cleanup.editSessionClosedOrNotCreated
    && cleanup.noActiveProcess
    && cleanup.noDirtyDiff);
}

const READ_ONLY_INTENT = /\b(read|inspect|analy[sz]e|audit|review|summari[sz]e|explain|diagnose|investigate|search|find|report|compare|trace)\b|只读|分析|审计|检查|排查|调查|搜索|查找|报告|对比|梳理/i;
const CHANGE_INTENT = /\b(edit|change|modify|implement|fix|refactor|write|create|update|migrate|replace|delete|remove)\b|修改|实现|修复|重构|写入|创建|更新|迁移|替换|删除/i;
const DESTRUCTIVE_INTENT = /\b(rm\s+-rf|reset\s+--hard|force[- ]?push|rewrite\s+history|drop\s+(table|database)|truncate\s+table|delete\s+all|purge|destroy|irreversible|production\s+data|prod\s+data)\b|强制推送|重写历史|清空数据库|删除全部|不可逆|生产数据/i;
const SENSITIVE_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\/)\.github\/workflows(\/|$)/i, 'CI workflow'],
  [/(^|\/)(deploy|infra|terraform|k8s|helm)(\/|$)/i, 'deployment or infrastructure'],
  [/(^|\/)(migrations?|schema|database|db)(\/|$)/i, 'database or migration'],
  [/(^|\/)(auth|security|permissions?|billing|payments?)(\/|$)/i, 'security or billing'],
  [/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/i, 'dependency lockfile'],
];

function normalizeRisk(value: TaskRisk | undefined): TaskRisk {
  return value ?? 'medium';
}

function sensitivePathLabels(paths: readonly string[]): string[] {
  const labels = new Set<string>();
  for (const path of paths) {
    for (const [pattern, label] of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(path)) labels.add(label);
    }
  }
  return [...labels];
}

export function classifyTaskExecution(task: Pick<ControllerTask, 'objective' | 'title' | 'risk' | 'allowedPaths' | 'forbiddenPaths'>): {
  risk: TaskRisk;
  executionClass: TaskExecutionClass;
  sensitivePaths: string[];
  destructiveSignals: string[];
} {
  const text = `${task.title}\n${task.objective}`;
  const paths = [...task.allowedPaths, ...task.forbiddenPaths];
  const sensitivePaths = sensitivePathLabels(paths);
  const destructiveSignals: string[] = [];
  if (DESTRUCTIVE_INTENT.test(text)) destructiveSignals.push('destructive intent');
  if (paths.some((path) => /(^|\/)(migrations?|database|db|prod|production)(\/|$)/i.test(path)) && /delete|drop|truncate|purge|清空|删除/i.test(text)) {
    destructiveSignals.push('high-risk data mutation');
  }

  let risk = normalizeRisk(task.risk);
  if (destructiveSignals.length > 0) risk = 'destructive';
  else if (risk !== 'destructive' && sensitivePaths.length > 0 && (risk === 'readonly' || risk === 'low')) risk = 'medium';

  if (risk === 'readonly') return { risk, executionClass: 'read_only', sensitivePaths, destructiveSignals };
  if (risk === 'destructive') return { risk, executionClass: 'destructive_change', sensitivePaths, destructiveSignals };
  if (risk === 'high') return { risk, executionClass: 'high_risk_change', sensitivePaths, destructiveSignals };
  if (risk === 'medium') return { risk, executionClass: 'medium_risk_change', sensitivePaths, destructiveSignals };

  const inferredReadOnly = READ_ONLY_INTENT.test(text) && !CHANGE_INTENT.test(text) && task.allowedPaths.length === 0;
  return {
    risk: inferredReadOnly ? 'readonly' : risk,
    executionClass: inferredReadOnly ? 'read_only' : 'low_risk_change',
    sensitivePaths,
    destructiveSignals,
  };
}

export function taskExecutionPolicy(task: Pick<ControllerTask, 'objective' | 'title' | 'risk' | 'allowedPaths' | 'forbiddenPaths' | 'checks' | 'acceptanceCriteria'>): TaskExecutionPolicy {
  const classification = classifyTaskExecution(task);
  const warnings: string[] = [];
  if (task.checks.length === 0) warnings.push('No named checks are declared; launch remains allowed and completion will rely on Run or reported command evidence.');
  if (task.acceptanceCriteria.length === 0) warnings.push('No Task-level acceptance criteria are declared.');
  if (task.allowedPaths.length === 0 && classification.executionClass !== 'read_only') warnings.push('No allowed path scope is declared; runtime path and conflict guards remain authoritative.');

  switch (classification.executionClass) {
    case 'read_only':
      return {
        ...classification,
        approval: 'auto',
        requiresScopedPaths: false,
        requiresDiffEvidence: false,
        requiresAnyVerificationEvidence: false,
        requiresAcceptanceEvidence: false,
        requiresHumanAcceptance: false,
        autoRunDeclaredChecks: false,
        autoCompleteAfterSuccessfulRun: true,
        warnings,
      };
    case 'low_risk_change':
      return {
        ...classification,
        approval: 'auto',
        requiresScopedPaths: false,
        requiresDiffEvidence: false,
        requiresAnyVerificationEvidence: false,
        requiresAcceptanceEvidence: false,
        requiresHumanAcceptance: false,
        autoRunDeclaredChecks: task.checks.length > 0,
        autoCompleteAfterSuccessfulRun: true,
        warnings,
      };
    case 'medium_risk_change':
      return {
        ...classification,
        approval: 'auto',
        requiresScopedPaths: false,
        requiresDiffEvidence: false,
        requiresAnyVerificationEvidence: task.checks.length > 0,
        requiresAcceptanceEvidence: task.acceptanceCriteria.length > 0,
        requiresHumanAcceptance: false,
        autoRunDeclaredChecks: task.checks.length > 0,
        autoCompleteAfterSuccessfulRun: true,
        warnings,
      };
    case 'high_risk_change':
      return {
        ...classification,
        // V8 treats risk as execution metadata, not as a local approval gate.
        approval: 'auto',
        requiresScopedPaths: false,
        requiresDiffEvidence: true,
        requiresAnyVerificationEvidence: task.checks.length > 0,
        requiresAcceptanceEvidence: task.acceptanceCriteria.length > 0,
        requiresHumanAcceptance: true,
        autoRunDeclaredChecks: task.checks.length > 0,
        autoCompleteAfterSuccessfulRun: false,
        warnings,
      };
    case 'destructive_change':
      return {
        ...classification,
        approval: 'manual-only',
        requiresScopedPaths: true,
        requiresDiffEvidence: true,
        requiresAnyVerificationEvidence: true,
        requiresAcceptanceEvidence: true,
        requiresHumanAcceptance: true,
        autoRunDeclaredChecks: task.checks.length > 0,
        autoCompleteAfterSuccessfulRun: false,
        warnings,
      };
  }
}


export interface ExecutionScopeDescriptor {
  executionClass: TaskExecutionClass;
  allowedPaths: readonly string[];
}

function scopePrefix(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split(/[?*{\[]/, 1)[0]
    .replace(/\/+$/, '');
}

/**
 * Returns true only when two non-read-only Tasks declare overlapping write scopes.
 * Missing scope is not treated as a global lock: it is insufficient evidence of a
 * conflict and the workspace isolation guard remains authoritative. A declared
 * repository-rooted globstar scope is intentionally broad
 * and conflicts with every other declared write scope.
 */
export function executionScopesConflict(
  left: ExecutionScopeDescriptor,
  right: ExecutionScopeDescriptor,
): boolean {
  if (left.executionClass === 'read_only' || right.executionClass === 'read_only') return false;
  if (left.allowedPaths.length === 0 || right.allowedPaths.length === 0) return false;
  for (const leftPath of left.allowedPaths) {
    const a = scopePrefix(leftPath);
    if (!a) return true;
    for (const rightPath of right.allowedPaths) {
      const b = scopePrefix(rightPath);
      if (!b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

export function taskWriteScopesConflict(
  left: Pick<ControllerTask, 'objective' | 'title' | 'risk' | 'allowedPaths' | 'forbiddenPaths'>,
  right: Pick<ControllerTask, 'objective' | 'title' | 'risk' | 'allowedPaths' | 'forbiddenPaths'>,
): boolean {
  const leftClass = classifyTaskExecution(left).executionClass;
  const rightClass = classifyTaskExecution(right).executionClass;
  return executionScopesConflict(
    { executionClass: leftClass, allowedPaths: left.allowedPaths },
    { executionClass: rightClass, allowedPaths: right.allowedPaths },
  );
}

const LEGACY_AUTOMATIC_ACCEPTANCE = /(?:^successful run [^;]+(?: integrated by [^;]+)?\.?$|successful run .*acceptance evidence|accepted from successful run)/i;

export function taskAcceptanceOutcome(result: TaskAcceptanceResult | undefined): TaskAcceptanceOutcome | 'missing' {
  if (!result) return 'missing';
  if (result.outcome) return result.outcome;
  if (result.source === 'run_completion') return 'not_evaluated';
  if (result.evidence && LEGACY_AUTOMATIC_ACCEPTANCE.test(result.evidence)) return 'not_evaluated';
  return result.ok ? 'passed' : 'failed';
}

export function verificationEvidencePassed(task: Pick<ControllerTask, 'checks' | 'acceptanceCriteria'>, verification: TaskVerification | undefined, policy: TaskExecutionPolicy): {
  status: 'passed' | 'failed' | 'incomplete';
  ok: boolean;
  checksOk: boolean;
  acceptanceOk: boolean;
  hasEvidence: boolean;
  reasons: string[];
} {
  if (!verification) {
    const ok = !policy.requiresAnyVerificationEvidence && !policy.requiresAcceptanceEvidence && !policy.requiresDiffEvidence;
    return {
      status: ok ? 'passed' : 'incomplete',
      ok,
      checksOk: !policy.requiresAnyVerificationEvidence,
      acceptanceOk: !policy.requiresAcceptanceEvidence,
      hasEvidence: false,
      reasons: ok ? [] : ['No persisted verification evidence.'],
    };
  }
  const reportedCommands = verification.commandEvidence ?? [];
  const hasEvidence = verification.checkResults.length > 0 || reportedCommands.length > 0 || Boolean(verification.runId);
  const evidenceFailed = verification.checkResults.some((entry) => !entry.ok)
    || reportedCommands.some((entry) => !entry.ok);
  const namedChecksComplete = task.checks.length === 0 || task.checks.every((checkId) =>
    verification.checkResults.some((entry) => entry.checkId === checkId && entry.ok),
  );
  const declaredChecksRequired = policy.autoRunDeclaredChecks && task.checks.length > 0;
  const checksOk = !evidenceFailed && (declaredChecksRequired
    ? namedChecksComplete
    : policy.requiresAnyVerificationEvidence
      ? hasEvidence
      : true);

  const acceptanceOutcomes = task.acceptanceCriteria.map((criterion) => taskAcceptanceOutcome(
    verification.acceptanceResults.find((entry) => entry.criterion === criterion),
  ));
  const acceptanceFailed = policy.requiresAcceptanceEvidence && acceptanceOutcomes.some((outcome) => outcome === 'failed');
  const acceptanceComplete = !policy.requiresAcceptanceEvidence
    || task.acceptanceCriteria.length === 0
    || acceptanceOutcomes.every((outcome) => outcome === 'passed');
  const acceptanceOk = acceptanceComplete && !acceptanceFailed;
  const diffOk = !policy.requiresDiffEvidence || Boolean(verification.reviewedDiffHash || verification.integratedRevision);
  const failed = evidenceFailed || acceptanceFailed;
  const complete = checksOk && acceptanceOk && diffOk;
  const status = failed ? 'failed' : complete ? 'passed' : 'incomplete';
  const reasons: string[] = [];
  if (evidenceFailed) reasons.push('One or more executed checks or reported commands failed.');
  else if (!checksOk) reasons.push('Required named checks or equivalent command evidence are missing.');
  if (acceptanceFailed) reasons.push('One or more acceptance criteria explicitly failed.');
  else if (!acceptanceOk) reasons.push('One or more acceptance criteria are missing or not evaluated.');
  if (policy.requiresAnyVerificationEvidence && !hasEvidence) reasons.push('This risk class requires persisted verification evidence.');
  if (!diffOk) reasons.push('This risk class requires reviewed Diff or integrated revision evidence.');
  return { status, ok: status === 'passed', checksOk, acceptanceOk, hasEvidence, reasons };
}
