import type { ExecutionJob } from './types';
import type { OperationReceipt } from './receipt-store';

/** Durable pointer from a short-lived parent Execution Job to its child Agent Run. */
export interface ExecutionChildReference {
  localJobId?: string;
  runId?: string;
  issueId?: string;
  taskId?: string;
  delegatedAt?: string;
  requestId?: string;
}

export const AGENT_DELEGATION_OPERATIONS = new Set([
  'dispatch_task',
  'launch_issue',
  'dispatch_ready_tasks',
  'retry_task_run',
  'quick_agent_session',
]);

export const AGENT_DELEGATION_LOCAL_ACTIONS = new Set([
  'launch-task',
  'quick-agent-session',
]);

export function isAgentDelegationOperation(operation: string | undefined): boolean {
  if (!operation) return false;
  return AGENT_DELEGATION_OPERATIONS.has(operation);
}

export function isAgentDelegationLocalAction(action: string | undefined): boolean {
  if (!action) return false;
  return AGENT_DELEGATION_LOCAL_ACTIONS.has(action);
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function pickChildReference(source: Record<string, unknown> | undefined): ExecutionChildReference | undefined {
  if (!source) return undefined;
  const nested = source.childReference && typeof source.childReference === 'object' && !Array.isArray(source.childReference)
    ? source.childReference as Record<string, unknown>
    : source;
  const localJob = nested.job && typeof nested.job === 'object' && !Array.isArray(nested.job)
    ? nested.job as Record<string, unknown>
    : undefined;
  const localJobId = stringField(nested.localJobId)
    ?? stringField(nested.jobId)
    ?? stringField(localJob?.jobId);
  const runId = stringField(nested.runId) ?? stringField(localJob?.runId);
  const issueId = stringField(nested.issueId) ?? stringField(localJob?.issueId);
  const taskId = stringField(nested.taskId) ?? stringField(localJob?.taskId);
  const requestId = stringField(nested.requestId);
  const delegatedAt = stringField(nested.delegatedAt);
  if (!localJobId && !runId && !issueId && !taskId) return undefined;
  return {
    ...(localJobId ? { localJobId } : {}),
    ...(runId ? { runId } : {}),
    ...(issueId ? { issueId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(delegatedAt ? { delegatedAt } : {}),
  };
}

export function childReferenceFromUnknown(value: unknown): ExecutionChildReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return pickChildReference(value as Record<string, unknown>);
}

export function childReferenceFromReceipt(receipt: OperationReceipt | undefined): ExecutionChildReference | undefined {
  if (!receipt) return undefined;
  return childReferenceFromUnknown(receipt.childReference)
    ?? childReferenceFromUnknown(receipt.result);
}

export function childReferenceFromJob(job: ExecutionJob | undefined): ExecutionChildReference | undefined {
  if (!job) return undefined;
  return childReferenceFromUnknown(job.result)
    ?? childReferenceFromUnknown(job.payload.arguments);
}

export function mergeChildReferences(
  ...refs: Array<ExecutionChildReference | undefined>
): ExecutionChildReference | undefined {
  const merged: ExecutionChildReference = {};
  for (const ref of refs) {
    if (!ref) continue;
    if (ref.localJobId) merged.localJobId = ref.localJobId;
    if (ref.runId) merged.runId = ref.runId;
    if (ref.issueId) merged.issueId = ref.issueId;
    if (ref.taskId) merged.taskId = ref.taskId;
    if (ref.requestId) merged.requestId = ref.requestId;
    if (ref.delegatedAt) merged.delegatedAt = ref.delegatedAt;
  }
  if (!merged.localJobId && !merged.runId && !merged.issueId && !merged.taskId) return undefined;
  return merged;
}

export function hasDurableChildReference(ref: ExecutionChildReference | undefined): boolean {
  return Boolean(ref?.runId || ref?.localJobId);
}

export function buildDelegatedExecutionResult(input: {
  childReference: ExecutionChildReference;
  localJob?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    delegated: true,
    delegationAccepted: true,
    childReference: input.childReference,
    localJobId: input.childReference.localJobId,
    runId: input.childReference.runId,
    issueId: input.childReference.issueId,
    taskId: input.childReference.taskId,
    ...(input.localJob ? { localJob: input.localJob, job: input.localJob } : {}),
    ...(input.extra ?? {}),
  };
}
