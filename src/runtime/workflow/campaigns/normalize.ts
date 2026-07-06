const OPERATION_ALIASES = new Map<string, string>([
  ['launch_task', 'dispatch_task'],
  ['launch_ready_tasks', 'dispatch_ready_tasks'],
  ['retry_run', 'retry_task_run'],
  ['integrate_run', 'integrate_task_run'],
  ['verify_edit', 'verify_edit_session'],
  ['repository_command', 'repository_command_execute'],
  ['command_execute', 'repository_command_execute'],
  ['quick_agent_run', 'quick_agent_session'],
]);

const OBSOLETE_OPERATION_MESSAGES = new Map<string, string>([
  ['prepare_issue_launch', 'prepare_issue_launch is obsolete for Campaigns; use launch_issue after readiness review or dispatch_task for one scoped Task.'],
]);

function extractDependencyReference(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['task_id', 'taskId', 'id', 'reference', 'ref', 'dependency']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

function operationToken(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function normalizeCampaignOperationName(value: string): string {
  const normalized = operationToken(value);
  return OPERATION_ALIASES.get(normalized) ?? normalized;
}

export function assertCampaignOperationSupported(value: string): string {
  const operation = normalizeCampaignOperationName(value);
  if (!operation) throw new Error('CAMPAIGN_TASK_OPERATION_REQUIRED');
  if (operation.startsWith('work_')) {
    throw new Error(`CAMPAIGN_OPERATION_INVALID: ${value} is a Work wrapper, not a Campaign task operation.`);
  }
  const obsolete = OBSOLETE_OPERATION_MESSAGES.get(operation);
  if (obsolete) throw new Error(`CAMPAIGN_OPERATION_OBSOLETE: ${obsolete}`);
  return operation;
}

export function normalizeCampaignDependencyReference(value: unknown): string | undefined {
  let text = extractDependencyReference(value)?.trim();
  if (!text) return undefined;
  text = text.replace(/^`+|`+$/g, '').trim();
  while (text.startsWith('#')) text = text.slice(1).trim();
  const prefixed = /^(?:task|task_id|task-id|dependency|depends_on|depends-on|campaign[_ -]?task|campaign\.task|campaign\/task)[:/#-]+(.+)$/i.exec(text);
  if (prefixed) text = prefixed[1]?.trim() ?? '';
  return text || undefined;
}

function dependencyLookupKeys(value: string): string[] {
  const normalized = normalizeCampaignDependencyReference(value) ?? value.trim();
  const keys = new Set<string>();
  for (const candidate of [value.trim(), normalized]) {
    if (!candidate) continue;
    keys.add(candidate);
    keys.add(candidate.toLowerCase());
    const token = operationToken(candidate);
    if (token) keys.add(token);
  }
  return [...keys];
}

export function normalizeCampaignDependencyReferences(
  values: readonly unknown[],
  knownTaskIds: readonly string[] = [],
): string[] {
  const actualTaskIds = knownTaskIds.map((value) => value.trim()).filter(Boolean);
  const lookup = new Map<string, string>();
  for (const taskId of actualTaskIds) {
    for (const key of dependencyLookupKeys(taskId)) if (!lookup.has(key)) lookup.set(key, taskId);
  }
  const normalized: string[] = [];
  for (const value of values) {
    const reference = normalizeCampaignDependencyReference(value);
    if (!reference) continue;
    const resolved = dependencyLookupKeys(reference).map((key) => lookup.get(key)).find(Boolean) ?? reference;
    if (!normalized.includes(resolved)) normalized.push(resolved);
  }
  return normalized;
}

export function normalizeCampaignTaskReferences<T extends { taskId: string; dependsOn: string[] }>(tasks: T[]): T[] {
  const taskIds = tasks.map((task) => task.taskId);
  for (const task of tasks) {
    task.dependsOn = normalizeCampaignDependencyReferences(task.dependsOn, taskIds);
  }
  return tasks;
}
