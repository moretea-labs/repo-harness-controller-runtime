import type { ExecutionJobPriority, ResourceClaimSpec } from '../../execution/jobs/types';

export type ScheduleTriggerType =
  | 'interval'
  | 'cron'
  | 'calendar'
  | 'condition'
  | 'repository-event'
  | 'dependency-checkpoint'
  | 'manual';

export interface ScheduleCondition {
  kind: 'repository_clean' | 'job_succeeded' | 'job_terminal' | 'candidate_observation_threshold';
  jobId?: string;
  semanticKey?: string;
  observationThreshold?: number;
}

export interface ScheduleTrigger {
  type: ScheduleTriggerType;
  everyMinutes?: number;
  cronExpression?: string;
  calendarAt?: string;
  condition?: ScheduleCondition;
  eventName?: string;
  dependencyJobIds?: string[];
}

export interface ScheduleTriggerContext {
  source?: 'timer' | 'manual' | 'repository-event' | 'dependency-checkpoint' | 'condition';
  eventName?: string;
  eventId?: string;
  data?: Record<string, unknown>;
}

export interface SchedulePolicy {
  maxActiveOccurrences: number;
  maxFailures: number;
  cooldownMinutes: number;
  dailyBudgetMinutes: number;
  shadowMode: boolean;
  backoffBaseMinutes?: number;
  backoffMaxMinutes?: number;
}

export interface ScheduleAction {
  operation: string;
  arguments?: Record<string, unknown>;
  priority?: ExecutionJobPriority;
  resourceClaims?: ResourceClaimSpec[];
}

export interface RepositorySchedule {
  schemaVersion: 1;
  revision: number;
  scheduleId: string;
  requestId: string;
  repoId: string;
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  policy: SchedulePolicy;
  action: ScheduleAction;
  stopConditions: string[];
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt?: string;
  lastOccurrenceId?: string;
  consecutiveFailures: number;
  consecutiveNoops?: number;
  nextEligibleAt?: string;
  pausedReason?: string;
}

export type ScheduleDecisionType =
  | 'nothing_to_do'
  | 'would_execute'
  | 'execute'
  | 'cooldown'
  | 'budget_exhausted'
  | 'active_occurrence'
  | 'stopped'
  | 'operation_blocked'
  | 'maintenance_not_ready'
  | 'trigger_not_due'
  | 'condition_not_met'
  | 'dependency_not_ready'
  | 'event_not_matched';

export interface ScheduleDecision {
  schemaVersion: 1;
  revision: number;
  decisionId: string;
  occurrenceId: string;
  scheduleId: string;
  repoId: string;
  requestId: string;
  decision: ScheduleDecisionType;
  reason?: string;
  triggerContext?: ScheduleTriggerContext;
  evidence?: Record<string, unknown>;
  createdAt: string;
}

export interface ScheduleOccurrence {
  schemaVersion: 1;
  revision: number;
  occurrenceId: string;
  scheduleId: string;
  repoId: string;
  windowKey: string;
  status: 'created' | 'shadowed' | 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  decision: ScheduleDecisionType;
  decisionId?: string;
  triggerContext?: ScheduleTriggerContext;
  createdAt: string;
  updatedAt: string;
  jobId?: string;
  handoffId?: string;
  reason?: string;
}
