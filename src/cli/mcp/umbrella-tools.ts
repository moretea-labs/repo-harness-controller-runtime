import { createUmbrellaIssue, getUmbrellaIssue, listUmbrellaIssues, updateUmbrellaTask } from '../repositories/umbrella';
import type { McpToolDefinition } from './tools';
import type { RepositoryToolResult } from './repository-tools';

export const umbrellaToolDefinitions: McpToolDefinition[] = [
  {
    name: 'umbrella_list',
    description: 'List cross-repository umbrella work items.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'umbrella_get',
    description: 'Inspect one cross-repository umbrella work item.',
    inputSchema: {
      type: 'object',
      properties: { umbrella_id: { type: 'string' } },
      required: ['umbrella_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'umbrella_create',
    description: 'Create an umbrella work item whose executable tasks each belong to exactly one repository.',
    inputSchema: {
      type: 'object',
      properties: {
        umbrella_id: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              repo_id: { type: 'string' },
              task_id: { type: 'string' },
              issue_id: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['repo_id', 'task_id', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['umbrella_id', 'title', 'tasks'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  {
    name: 'umbrella_update_task',
    description: 'Record a repository-local task outcome without claiming cross-repository atomic success.',
    inputSchema: {
      type: 'object',
      properties: {
        umbrella_id: { type: 'string' },
        repo_id: { type: 'string' },
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'] },
        run_id: { type: 'string' },
        commit_sha: { type: 'string' },
        rollback_ref: { type: 'string' },
        error: { type: 'string' },
      },
      required: ['umbrella_id', 'repo_id', 'task_id', 'status'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
];

function result(value: Record<string, unknown>): RepositoryToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

export function callUmbrellaTool(controllerHome: string, name: string, args: Record<string, unknown>): RepositoryToolResult | undefined {
  if (!name.startsWith('umbrella_')) return undefined;
  try {
    if (name === 'umbrella_list') return result({ umbrellaIssues: listUmbrellaIssues(controllerHome) });
    if (name === 'umbrella_get') return result({ umbrellaIssue: getUmbrellaIssue(String(args.umbrella_id ?? ''), controllerHome) });
    if (name === 'umbrella_create') {
      const tasks = Array.isArray(args.tasks) ? args.tasks.map((value) => {
        const task = value as Record<string, unknown>;
        return {
          repoId: String(task.repo_id ?? ''),
          taskId: String(task.task_id ?? ''),
          issueId: typeof task.issue_id === 'string' ? task.issue_id : undefined,
          title: String(task.title ?? ''),
        };
      }) : [];
      return result({ umbrellaIssue: createUmbrellaIssue({
        controllerHome,
        umbrellaId: String(args.umbrella_id ?? ''),
        title: String(args.title ?? ''),
        summary: typeof args.summary === 'string' ? args.summary : undefined,
        tasks,
      }) });
    }
    if (name === 'umbrella_update_task') return result({ umbrellaIssue: updateUmbrellaTask({
      controllerHome,
      umbrellaId: String(args.umbrella_id ?? ''),
      repoId: String(args.repo_id ?? ''),
      taskId: String(args.task_id ?? ''),
      status: String(args.status ?? '') as 'planned' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled',
      runId: typeof args.run_id === 'string' ? args.run_id : undefined,
      commitSha: typeof args.commit_sha === 'string' ? args.commit_sha : undefined,
      rollbackRef: typeof args.rollback_ref === 'string' ? args.rollback_ref : undefined,
      error: typeof args.error === 'string' ? args.error : undefined,
    }) });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...result({ error: { code: 'UMBRELLA_TOOL_FAILED', message } }), isError: true };
  }
}
