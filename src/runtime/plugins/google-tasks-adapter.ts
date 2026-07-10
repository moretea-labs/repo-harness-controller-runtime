import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import {
  type GoogleTasksPluginConfig,
  googleApiRequest,
  googlePermission,
  googleTasksPluginConfigPath,
  loadGoogleTasksPluginConfig,
  pluginStateFromGoogleAuth,
  resolveGoogleAuth,
  saveGoogleTasksPluginConfig,
  stableMockId,
} from './google-shared';

const GOOGLE_TASKS_PLUGIN_ID = 'google_tasks';

interface TasksProvider {
  listTaskLists(config: GoogleTasksPluginConfig): Promise<Record<string, unknown>>;
  listTasks(args: Record<string, unknown>, config: GoogleTasksPluginConfig): Promise<Record<string, unknown>>;
  createTask(args: Record<string, unknown>, config: GoogleTasksPluginConfig): Promise<Record<string, unknown>>;
  updateTask(args: Record<string, unknown>, config: GoogleTasksPluginConfig): Promise<Record<string, unknown>>;
  rescheduleTask(args: Record<string, unknown>, config: GoogleTasksPluginConfig): Promise<Record<string, unknown>>;
  completeTask(args: Record<string, unknown>, config: GoogleTasksPluginConfig): Promise<Record<string, unknown>>;
  deleteTask(args: Record<string, unknown>, config: GoogleTasksPluginConfig): Promise<Record<string, unknown>>;
}

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function tasksPermissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    googlePermission('tasks.readonly', 'read', 'Read Google Task lists and tasks.', ready),
    googlePermission('tasks.write', 'write', 'Create, update, complete, and reschedule Google Tasks.', ready),
    googlePermission('tasks.delete', 'write', 'Delete Google Tasks.', ready),
  ];
}

function tasksCapabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'tasks-read',
      title: 'Task Read',
      description: 'List task lists and tasks, including reminder-like due scheduling metadata.',
      scopes: ['tasks.readonly'],
      actions: ['list_tasklists', 'list_tasks'],
    },
    {
      capabilityId: 'tasks-plan',
      title: 'Task Plan',
      description: 'Create, update, complete, and reschedule tasks.',
      scopes: ['tasks.write'],
      actions: ['create_task', 'update_task', 'complete_task', 'reschedule_task'],
    },
    {
      capabilityId: 'tasks-delete',
      title: 'Task Delete',
      description: 'Delete tasks after strong confirmation.',
      scopes: ['tasks.delete'],
      actions: ['delete_task'],
    },
  ];
}

function tasksActions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'configure',
      title: 'Configure Google Tasks plugin',
      description: 'Enable Google Tasks access, choose provider mode, and save non-secret task defaults.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['tasks.readonly', 'tasks.write', 'tasks.delete'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          provider: { type: 'string', enum: ['mock', 'google-workspace'] },
          account_email: { type: 'string' },
          clear_account_email: { type: 'boolean' },
          task_list_id: { type: 'string' },
          clear_task_list_id: { type: 'boolean' },
          include_completed: { type: 'boolean' },
          default_timeout_ms: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'list_tasklists',
      title: 'List task lists',
      description: 'List Google Task lists.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['tasks.readonly'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      actionId: 'list_tasks',
      title: 'List tasks',
      description: 'List tasks from one Google Task list.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['tasks.readonly'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          task_list_id: { type: 'string' },
          max_results: { type: 'number' },
          include_completed: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'create_task',
      title: 'Create task',
      description: 'Create a task or reminder entry.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: false,
      scopes: ['tasks.write'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          task_list_id: { type: 'string' },
          title: { type: 'string' },
          notes: { type: 'string' },
          due: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'update_task',
      title: 'Update task',
      description: 'Update task title, notes, or due date.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: false,
      scopes: ['tasks.write'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          task_list_id: { type: 'string' },
          task_id: { type: 'string' },
          title: { type: 'string' },
          notes: { type: 'string' },
          due: { type: 'string' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'reschedule_task',
      title: 'Reschedule task',
      description: 'Move a task or reminder to a different due date.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'reschedule-google-task',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: false,
      scopes: ['tasks.write'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          task_list_id: { type: 'string' },
          task_id: { type: 'string' },
          due: { type: 'string' },
        },
        required: ['task_id', 'due'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'complete_task',
      title: 'Complete task',
      description: 'Mark a task complete.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: true,
      scopes: ['tasks.write'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          task_list_id: { type: 'string' },
          task_id: { type: 'string' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'delete_task',
      title: 'Delete task',
      description: 'Delete a task.',
      readOnly: false,
      risk: 'destructive',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'delete-google-task',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: true,
      scopes: ['tasks.delete'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          task_list_id: { type: 'string' },
          task_id: { type: 'string' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
  ];
}

function taskPatch(args: Record<string, unknown>): Record<string, unknown> {
  const title = stringValue(args.title);
  const notes = stringValue(args.notes);
  const due = stringValue(args.due);
  return {
    ...(title ? { title } : {}),
    ...(notes ? { notes } : {}),
    ...(due ? { due } : {}),
  };
}

function mockTasksProvider(): TasksProvider {
  return {
    async listTaskLists(config) {
      return {
        provider: 'mock',
        items: [{
          id: config.taskListId ?? '@default',
          title: 'Mock task list',
          updated: now(),
        }],
      };
    },
    async listTasks(args, config) {
      const taskId = stableMockId('gtask', { taskListId: args.task_list_id ?? config.taskListId });
      return {
        provider: 'mock',
        taskListId: String(args.task_list_id ?? config.taskListId ?? '@default'),
        items: [{
          id: taskId,
          title: 'Mock reminder',
          due: String(args.include_completed === true ? now() : new Date(Date.now() + 86_400_000).toISOString()),
          status: 'needsAction',
        }],
      };
    },
    async createTask(args, config) {
      return {
        provider: 'mock',
        taskListId: String(args.task_list_id ?? config.taskListId ?? '@default'),
        task: {
          id: stableMockId('gtask', args),
          title: String(args.title),
          notes: stringValue(args.notes),
          due: stringValue(args.due),
          status: 'needsAction',
          createdAt: now(),
        },
      };
    },
    async updateTask(args, config) {
      return {
        provider: 'mock',
        taskListId: String(args.task_list_id ?? config.taskListId ?? '@default'),
        task: {
          id: String(args.task_id),
          ...taskPatch(args),
          updatedAt: now(),
        },
      };
    },
    async rescheduleTask(args, config) {
      return {
        provider: 'mock',
        taskListId: String(args.task_list_id ?? config.taskListId ?? '@default'),
        task: {
          id: String(args.task_id),
          due: stringValue(args.due),
          updatedAt: now(),
        },
      };
    },
    async completeTask(args, config) {
      return {
        provider: 'mock',
        taskListId: String(args.task_list_id ?? config.taskListId ?? '@default'),
        task: {
          id: String(args.task_id),
          status: 'completed',
          completed: now(),
        },
      };
    },
    async deleteTask(args, config) {
      return {
        provider: 'mock',
        taskListId: String(args.task_list_id ?? config.taskListId ?? '@default'),
        task: {
          id: String(args.task_id),
          deleted: true,
          deletedAt: now(),
        },
      };
    },
  };
}

function liveTasksProvider(config: GoogleTasksPluginConfig, repoRoot?: string): TasksProvider {
  const auth = resolveGoogleAuth('tasks', config, { repoRoot });
  if (!auth.ready || !auth.accessToken) {
    throw new AssistantPluginError('PLUGIN_AUTH_REQUIRED', auth.errors[0] ?? 'Google Tasks access token is required.', {
      retryable: false,
      details: {
        pluginId: GOOGLE_TASKS_PLUGIN_ID,
        provider: config.provider,
      },
    });
  }
  const accessToken = auth.accessToken;
  const taskListId = (args?: Record<string, unknown>) => encodeURIComponent(String(args?.task_list_id ?? config.taskListId ?? '@default'));
  return {
    async listTaskLists() {
      return googleApiRequest<Record<string, unknown>>({
        service: 'tasks',
        path: '/tasks/v1/users/@me/lists',
        accessToken,
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async listTasks(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'tasks',
        path: `/tasks/v1/lists/${taskListId(args)}/tasks`,
        accessToken,
        query: {
          maxResults: positiveNumber(args.max_results, 50),
          showCompleted: args.include_completed === true || config.includeCompleted === true,
          showHidden: false,
        },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async createTask(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'tasks',
        path: `/tasks/v1/lists/${taskListId(args)}/tasks`,
        method: 'POST',
        accessToken,
        body: taskPatch(args),
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async updateTask(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'tasks',
        path: `/tasks/v1/lists/${taskListId(args)}/tasks/${encodeURIComponent(String(args.task_id))}`,
        method: 'PATCH',
        accessToken,
        body: taskPatch(args),
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async rescheduleTask(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'tasks',
        path: `/tasks/v1/lists/${taskListId(args)}/tasks/${encodeURIComponent(String(args.task_id))}`,
        method: 'PATCH',
        accessToken,
        body: { due: stringValue(args.due) },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async completeTask(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'tasks',
        path: `/tasks/v1/lists/${taskListId(args)}/tasks/${encodeURIComponent(String(args.task_id))}`,
        method: 'PATCH',
        accessToken,
        body: { status: 'completed', completed: now() },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async deleteTask(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'tasks',
        path: `/tasks/v1/lists/${taskListId(args)}/tasks/${encodeURIComponent(String(args.task_id))}`,
        method: 'DELETE',
        accessToken,
        timeoutMs: config.defaultTimeoutMs,
      });
    },
  };
}

function tasksProvider(config: GoogleTasksPluginConfig, repoRoot?: string): TasksProvider {
  return config.provider === 'mock' ? mockTasksProvider() : liveTasksProvider(config, repoRoot);
}

export function buildGoogleTasksPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const root = repoRoot ?? process.cwd();
  const config = loadGoogleTasksPluginConfig(root);
  const auth = resolveGoogleAuth('tasks', config, { repoRoot: root });
  const state = pluginStateFromGoogleAuth(config, auth);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: GOOGLE_TASKS_PLUGIN_ID,
    provider: 'google',
    displayName: 'Google Tasks Assistant Plugin',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: [`repo-local:${googleTasksPluginConfigPath()}`, 'env:REPO_HARNESS_*_ACCESS_TOKEN'],
    },
    enabled: config.enabled,
    lifecycle: {
      state: state.lifecycleState,
      reason: !config.enabled
        ? 'Google Tasks plugin is disabled.'
        : auth.ready
          ? `Google Tasks plugin is ready via ${auth.credentialSource}.`
          : auth.errors[0],
    },
    health: state.health,
    permissions: tasksPermissions(auth.ready),
    capabilities: tasksCapabilities(),
    actions: tasksActions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeGoogleTasksPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const current = loadGoogleTasksPluginConfig(input.repoRoot);
  switch (input.actionId) {
    case 'configure': {
      const args = input.args;
      const config = saveGoogleTasksPluginConfig(input.repoRoot, {
        enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled,
        provider: args.provider === 'google-workspace' ? 'google-workspace' : args.provider === 'mock' ? 'mock' : current.provider,
        accountEmail: args.clear_account_email === true ? undefined : stringValue(args.account_email) ?? current.accountEmail,
        taskListId: args.clear_task_list_id === true ? undefined : stringValue(args.task_list_id) ?? current.taskListId,
        includeCompleted: typeof args.include_completed === 'boolean' ? args.include_completed : current.includeCompleted,
        defaultTimeoutMs: typeof args.default_timeout_ms === 'number' ? positiveNumber(args.default_timeout_ms, 30_000) : current.defaultTimeoutMs,
      });
      return {
        config,
        auth: resolveGoogleAuth('tasks', config, { repoRoot: input.repoRoot }),
      };
    }
    case 'list_tasklists':
      return tasksProvider(current, input.repoRoot).listTaskLists(current);
    case 'list_tasks':
      return tasksProvider(current, input.repoRoot).listTasks(input.args, current);
    case 'create_task':
      return tasksProvider(current, input.repoRoot).createTask(input.args, current);
    case 'update_task':
      return tasksProvider(current, input.repoRoot).updateTask(input.args, current);
    case 'reschedule_task':
      return tasksProvider(current, input.repoRoot).rescheduleTask(input.args, current);
    case 'complete_task':
      return tasksProvider(current, input.repoRoot).completeTask(input.args, current);
    case 'delete_task':
      return tasksProvider(current, input.repoRoot).deleteTask(input.args, current);
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `google_tasks/${input.actionId} is not supported.`, {
        retryable: false,
      });
  }
}

export const googleTasksPluginAdapter = {
  pluginId: GOOGLE_TASKS_PLUGIN_ID,
  buildManifest: buildGoogleTasksPluginManifest,
  executeAction: executeGoogleTasksPluginAction,
};
