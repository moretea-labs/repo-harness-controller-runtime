import { createHash } from 'crypto';
import type { CapabilityRecoverySnapshot, RecoveryClass } from './types';
import type { RuntimeMaintenanceStatus } from './maintenance-executor';
import { classifyFailure, dominantRecoveryClass } from './classifier';

export type SelfHealingFindingSeverity = 'low' | 'medium' | 'high' | 'critical';
export type SelfHealingFindingKind = 'runtime' | 'auth' | 'browser' | 'filesystem' | 'source' | 'platform' | 'unknown';
export type SelfHealingNextStepOwner = 'repo-harness' | 'local-user' | 'chatgpt' | 'codex-cli' | 'deepseek' | 'human';

export interface SelfHealingObservation {
  id: string;
  kind: SelfHealingFindingKind;
  class: RecoveryClass;
  severity: SelfHealingFindingSeverity;
  summary: string;
  evidence: Record<string, unknown>;
  safeAutomaticActions: string[];
  requiresAuthorization: string[];
  forbiddenAutomaticActions: string[];
}

export interface SelfHealingCandidateFindingDraft {
  semanticKey: string;
  title: string;
  summary: string;
  severity: SelfHealingFindingSeverity;
  reference: string;
  evidence: Record<string, unknown>;
}

export interface SelfHealingNextStep {
  id: string;
  owner: SelfHealingNextStepOwner;
  action: string;
  reason: string;
  requiresHumanApproval: boolean;
}

export interface SelfHealingMonitorReport {
  schemaVersion: 1;
  generatedAt: string;
  repoId: string;
  mode: 'shadow' | 'active';
  overallState: 'ready' | 'degraded' | 'blocked';
  failureSignature: string;
  observations: SelfHealingObservation[];
  candidateFindings: SelfHealingCandidateFindingDraft[];
  nextSteps: SelfHealingNextStep[];
  automationPolicy: {
    canAutoApplyLocalMaintenance: boolean;
    canAutoCreateCandidateFindings: boolean;
    canAutoModifySource: boolean;
    canAutoMergeOrPush: boolean;
  };
  cadenceRecommendation: {
    hourly: string[];
    daily: string[];
    weekly: string[];
  };
  safetyInvariants: string[];
}

export interface SelfHealingMonitorInput {
  repoId: string;
  mode?: 'shadow' | 'active';
  recovery?: CapabilityRecoverySnapshot;
  maintenance?: RuntimeMaintenanceStatus;
  auth?: unknown;
  browser?: unknown;
  externalFilesystem?: unknown;
  recentErrors?: string[];
}

function now(): string { return new Date().toISOString(); }

function stableKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function severityForClass(recoveryClass: RecoveryClass): SelfHealingFindingSeverity {
  if (['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable', 'maintenance_executor_required'].includes(recoveryClass)) return 'high';
  if (['platform_blocked', 'source_defect_suspected'].includes(recoveryClass)) return 'high';
  if (['auth_required', 'browser_domain_grant_required', 'external_filesystem_grant_required'].includes(recoveryClass)) return 'medium';
  if (['policy_denied', 'dirty_worktree_conflict', 'agent_runtime_failure'].includes(recoveryClass)) return 'medium';
  return 'low';
}

function kindForClass(recoveryClass: RecoveryClass): SelfHealingFindingKind {
  if (['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable', 'local_jobs_reconciliation_required', 'maintenance_executor_required', 'stale_runtime_state'].includes(recoveryClass)) return 'runtime';
  if (recoveryClass === 'auth_required') return 'auth';
  if (recoveryClass === 'browser_domain_grant_required') return 'browser';
  if (recoveryClass === 'external_filesystem_grant_required') return 'filesystem';
  if (recoveryClass === 'source_defect_suspected') return 'source';
  if (recoveryClass === 'platform_blocked') return 'platform';
  return 'unknown';
}

function observationFromFailure(recoveryClass: RecoveryClass, message: string, index: number): SelfHealingObservation {
  const kind = kindForClass(recoveryClass);
  const safeAutomaticActions = kind === 'runtime'
    ? ['runtime_maintenance_status']
    : [];
  const requiresAuthorization = kind === 'runtime'
    ? ['runtime_maintenance_apply when candidate is safe']
    : kind === 'auth'
      ? ['workspace_auth_login_prepare via local GUI/CLI']
      : kind === 'browser'
        ? ['web_domain_access_preview/apply']
        : kind === 'filesystem'
          ? ['external_filesystem_grant_preview/apply']
          : kind === 'source'
            ? ['isolated source repair worktree']
            : [];
  return {
    id: `recent-error-${index + 1}`,
    kind,
    class: recoveryClass,
    severity: severityForClass(recoveryClass),
    summary: message.slice(0, 240),
    evidence: { message },
    safeAutomaticActions,
    requiresAuthorization,
    forbiddenAutomaticActions: ['auto merge', 'auto push', 'secret export', 'arbitrary shell cleanup'],
  };
}

function runtimeObservation(maintenance: RuntimeMaintenanceStatus): SelfHealingObservation | undefined {
  if (maintenance.readyForExecution && maintenance.summary.totalCandidates === 0) return undefined;
  const recoveryClass: RecoveryClass = maintenance.summary.unreadableLocalJobs > 0
    ? 'local_jobs_unreadable'
    : maintenance.summary.staleActiveLocalJobs > 0 || maintenance.summary.pendingApprovalLocalJobs > 0
      ? 'local_jobs_legacy_active'
      : maintenance.readyForExecution === false
        ? 'runtime_storage_not_ready'
        : 'local_jobs_reconciliation_required';
  return {
    id: 'runtime-maintenance',
    kind: 'runtime',
    class: recoveryClass,
    severity: severityForClass(recoveryClass),
    summary: maintenance.readyForExecution
      ? 'Runtime maintenance found local candidates that should be reconciled before they become blockers.'
      : 'Runtime storage is not ready or local-job metadata needs maintenance.',
    evidence: {
      readyForExecution: maintenance.readyForExecution,
      summary: maintenance.summary,
      recommendedActions: maintenance.recommendedActions,
      restartEscalation: maintenance.restartEscalation,
    },
    safeAutomaticActions: ['runtime_maintenance_status'],
    requiresAuthorization: maintenance.recommendedActions.map((action) => `runtime_maintenance_apply:${action}`),
    forbiddenAutomaticActions: ['delete source files', 'force cleanup non-runtime paths', 'auto push'],
  };
}

function recoveryObservations(recovery: CapabilityRecoverySnapshot | undefined): SelfHealingObservation[] {
  if (!recovery) return [];
  return recovery.capabilities
    .filter((capability) => capability.state !== 'ready' && capability.class !== 'unknown')
    .slice(0, 12)
    .map((capability) => ({
      id: capability.id,
      kind: kindForClass(capability.class),
      class: capability.class,
      severity: severityForClass(capability.class),
      summary: capability.reason,
      evidence: { state: capability.state, label: capability.label, evidence: capability.evidence.slice(0, 3) },
      safeAutomaticActions: capability.suggestedActions.filter((action) => action.confirmation === 'none').map((action) => action.id),
      requiresAuthorization: capability.suggestedActions.filter((action) => action.confirmation !== 'none').map((action) => action.id),
      forbiddenAutomaticActions: ['auto source repair', 'auto merge', 'auto remote write'],
    }));
}

function dedupeObservations(observations: SelfHealingObservation[]): SelfHealingObservation[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = `${observation.kind}:${observation.class}:${observation.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findingForObservation(repoId: string, observation: SelfHealingObservation): SelfHealingCandidateFindingDraft {
  const semanticKey = `self-healing:${repoId}:${observation.kind}:${observation.class}:${stableKey([observation.summary, observation.evidence])}`;
  return {
    semanticKey,
    title: `Self-healing ${observation.kind} finding: ${observation.class}`,
    summary: observation.summary,
    severity: observation.severity,
    reference: observation.id,
    evidence: {
      class: observation.class,
      kind: observation.kind,
      safeAutomaticActions: observation.safeAutomaticActions,
      requiresAuthorization: observation.requiresAuthorization,
      details: observation.evidence,
    },
  };
}

function nextSteps(observations: SelfHealingObservation[], mode: 'shadow' | 'active'): SelfHealingNextStep[] {
  const steps: SelfHealingNextStep[] = [];
  if (observations.some((observation) => observation.kind === 'runtime')) {
    steps.push({
      id: 'inspect-runtime-maintenance',
      owner: 'repo-harness',
      action: 'Run runtime_maintenance_status and apply only safe maintenance candidates when authorized.',
      reason: 'Runtime metadata blockers should be fixed locally before source repair or model delegation.',
      requiresHumanApproval: mode !== 'active',
    });
  }
  if (observations.some((observation) => observation.kind === 'auth')) {
    steps.push({
      id: 'prepare-auth-handoff',
      owner: 'local-user',
      action: 'Use the local GUI/CLI login handoff and retry the plugin operation after credentials are ready.',
      reason: 'Token material must not be returned to ChatGPT or persisted in repository files.',
      requiresHumanApproval: true,
    });
  }
  if (observations.some((observation) => observation.kind === 'browser' || observation.kind === 'filesystem')) {
    steps.push({
      id: 'typed-grant-review',
      owner: 'human',
      action: 'Review typed grant preview and apply only narrow, auditable grants.',
      reason: 'Access expansion must be explicit and minimally scoped.',
      requiresHumanApproval: true,
    });
  }
  if (observations.some((observation) => observation.kind === 'source' || observation.kind === 'platform')) {
    steps.push({
      id: 'isolated-repair',
      owner: 'chatgpt',
      action: 'Create an isolated repair task; use ChatGPT first, local Codex CLI second, DeepSeek third, human fallback last.',
      reason: 'Source repair should happen only after local maintenance and typed grants are exhausted.',
      requiresHumanApproval: true,
    });
  }
  if (steps.length === 0) {
    steps.push({
      id: 'keep-observing',
      owner: 'repo-harness',
      action: 'Continue shadow monitoring and do not create repair work.',
      reason: 'No actionable blocker was observed in this tick.',
      requiresHumanApproval: false,
    });
  }
  return steps;
}

export function buildSelfHealingMonitorReport(input: SelfHealingMonitorInput): SelfHealingMonitorReport {
  const mode = input.mode ?? 'shadow';
  const recentClasses = (input.recentErrors ?? []).map(classifyFailure);
  const recentObservations = (input.recentErrors ?? [])
    .map((message, index) => observationFromFailure(recentClasses[index] ?? 'unknown', message, index));
  const runtime = input.maintenance ? runtimeObservation(input.maintenance) : undefined;
  const observations = dedupeObservations([
    ...recoveryObservations(input.recovery),
    ...(runtime ? [runtime] : []),
    ...recentObservations,
  ]).slice(0, 20);
  const failureClass = dominantRecoveryClass(observations.map((observation) => observation.class));
  const overallState = observations.some((observation) => observation.severity === 'critical' || observation.class === 'runtime_storage_not_ready' || observation.class === 'local_jobs_legacy_active')
    ? 'blocked'
    : observations.length > 0
      ? 'degraded'
      : 'ready';
  return {
    schemaVersion: 1,
    generatedAt: now(),
    repoId: input.repoId,
    mode,
    overallState,
    failureSignature: `${failureClass}:${stableKey(observations.map((observation) => [observation.kind, observation.class, observation.summary]))}`,
    observations,
    candidateFindings: observations.map((observation) => findingForObservation(input.repoId, observation)),
    nextSteps: nextSteps(observations, mode),
    automationPolicy: {
      canAutoApplyLocalMaintenance: mode === 'active' && observations.every((observation) => observation.kind === 'runtime'),
      canAutoCreateCandidateFindings: true,
      canAutoModifySource: false,
      canAutoMergeOrPush: false,
    },
    cadenceRecommendation: {
      hourly: ['Run read-only self_healing_monitor_tick in shadow mode.', 'Escalate only runtime blockers with safe maintenance candidates.'],
      daily: ['Summarize candidate findings and deduplicate recurring signatures.'],
      weekly: ['Human-review top recurring findings and promote selected items to issues or goals.'],
    },
    safetyInvariants: [
      'Shadow monitor ticks must not mutate source, runtime state, credentials, browser state, or external files.',
      'Local maintenance may only touch repo-harness runtime metadata after explicit authorization.',
      'Credential, browser, and filesystem expansion must use typed handoff/grant flows.',
      'Model-assisted source repair must use isolated worktrees and human-reviewed merge gates.',
    ],
  };
}
