import type { ExecutionJob, ExecutionJobOrigin } from '../execution/jobs/types';

export type AssistantIntentMode = 'plan_only' | 'plan_then_execute' | 'execute';
export type AssistantIntentSource = 'chatgpt' | 'mcp' | 'local-ui' | 'mobile' | 'system';
export type AssistantPlanStepStatus = 'planned' | 'submitted' | 'blocked' | 'skipped';
export type AssistantRoutineStatus = 'enabled' | 'paused' | 'deleted';
export type AssistantInboxItemStatus = 'unread' | 'read' | 'archived';

export interface AssistantPlanStepInput {
  stepId?: string;
  pluginId: string;
  actionId: string;
  arguments?: Record<string, unknown>;
  requestId?: string;
  confirmAuthorization?: boolean;
  confirmationText?: string;
}

export interface AssistantPlanStepResult {
  stepId: string;
  pluginId: string;
  actionId: string;
  status: AssistantPlanStepStatus;
  risk: 'readonly' | 'workspace_write' | 'remote_write' | 'destructive' | 'unknown';
  decision: 'allow' | 'approval_required' | 'reject';
  reason: string;
  requiredConfirmationText?: string;
  job?: ExecutionJob;
}

export interface AssistantIntentInput {
  utterance?: string;
  source?: AssistantIntentSource;
  mode?: AssistantIntentMode;
  requestId?: string;
  timezone?: string;
  context?: Record<string, unknown>;
  plan?: AssistantPlanStepInput[];
  routine?: Partial<AssistantRoutineDraft>;
  confirmRoutine?: boolean;
}

export interface AssistantRoutineDraft {
  name: string;
  naturalLanguageGoal: string;
  scheduleText: string;
  timezone?: string;
  dataSources: string[];
  output: 'assistant_inbox' | 'gmail_draft' | 'none';
  allowedActions: string[];
  forbiddenActions: string[];
}

export interface AssistantRoutine extends AssistantRoutineDraft {
  schemaVersion: 1;
  routineId: string;
  status: AssistantRoutineStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunHint?: string;
}

export interface AssistantRoutinesStore {
  schemaVersion: 1;
  updatedAt: string;
  routines: AssistantRoutine[];
}

export interface AssistantInboxItem {
  schemaVersion: 1;
  itemId: string;
  kind: 'intent_result' | 'routine_result' | 'approval_request' | 'system_note';
  status: AssistantInboxItemStatus;
  title: string;
  summary: string;
  body?: string;
  createdAt: string;
  updatedAt: string;
  source: AssistantIntentSource | 'routine' | 'system';
  relatedRoutineId?: string;
  relatedRequestId?: string;
  jobIds: string[];
  recommendations: string[];
  data?: Record<string, unknown>;
}

export interface AssistantInboxStore {
  schemaVersion: 1;
  updatedAt: string;
  items: AssistantInboxItem[];
}

export interface AssistantMemoryEntry {
  key: string;
  value: string;
  updatedAt: string;
  source?: string;
}

export interface AssistantMemoryStore {
  schemaVersion: 1;
  updatedAt: string;
  entries: AssistantMemoryEntry[];
}

export interface AssistantIntentResult {
  schemaVersion: 1;
  accepted: boolean;
  mode: AssistantIntentMode;
  source: AssistantIntentSource;
  requestId: string;
  understoodIntent: string;
  displayTitle: string;
  displayText: string;
  requiresConfirmation: boolean;
  confirmationSummary?: string;
  routineDraft?: AssistantRoutineDraft;
  routine?: AssistantRoutine;
  plan: AssistantPlanStepResult[];
  inboxItem?: AssistantInboxItem;
  clarifyingQuestions: string[];
}

export interface AssistantPolicyDecision {
  decision: 'allow' | 'approval_required' | 'reject';
  reason: string;
  autoConfirmAuthorization: boolean;
  requiredConfirmationText?: string;
}

export interface AssistantExecutionContext {
  origin: ExecutionJobOrigin;
  requestId: string;
}
