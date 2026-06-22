import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ensureControllerHome } from './controller-home';
import { getRepository } from './registry';

export type UmbrellaTaskStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export interface UmbrellaRepositoryTask {
  taskId: string;
  repoId: string;
  issueId?: string;
  title: string;
  status: UmbrellaTaskStatus;
  runIds: string[];
  commitSha?: string;
  rollbackRef?: string;
  error?: string;
  updatedAt: string;
}

export interface UmbrellaIssue {
  schemaVersion: 1;
  umbrellaId: string;
  title: string;
  summary: string;
  status: 'planned' | 'running' | 'partial' | 'failed' | 'done' | 'cancelled';
  tasks: UmbrellaRepositoryTask[];
  createdAt: string;
  updatedAt: string;
}

function root(controllerHome?: string): string {
  return join(ensureControllerHome(controllerHome), 'umbrella-issues');
}

function pathFor(controllerHome: string | undefined, umbrellaId: string): string {
  return join(root(controllerHome), `${umbrellaId.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`);
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

function deriveStatus(tasks: UmbrellaRepositoryTask[]): UmbrellaIssue['status'] {
  if (tasks.every((task) => task.status === 'cancelled')) return 'cancelled';
  if (tasks.every((task) => task.status === 'succeeded')) return 'done';
  if (tasks.some((task) => task.status === 'failed') && tasks.some((task) => task.status === 'succeeded')) return 'partial';
  if (tasks.some((task) => task.status === 'failed')) return 'failed';
  if (tasks.some((task) => task.status === 'running')) return 'running';
  if (tasks.some((task) => task.status === 'blocked')) return 'partial';
  return 'planned';
}

export function createUmbrellaIssue(input: {
  controllerHome?: string;
  umbrellaId: string;
  title: string;
  summary?: string;
  tasks: Array<{ taskId: string; repoId: string; title: string; issueId?: string }>;
}): UmbrellaIssue {
  if (input.tasks.length < 2) throw new Error('UMBRELLA_REQUIRES_MULTIPLE_REPOSITORIES');
  const repoIds = new Set(input.tasks.map((task) => task.repoId));
  if (repoIds.size < 2) throw new Error('UMBRELLA_REQUIRES_MULTIPLE_REPOSITORIES');
  for (const repoId of repoIds) getRepository(repoId, input.controllerHome);
  const path = pathFor(input.controllerHome, input.umbrellaId);
  if (existsSync(path)) throw new Error(`umbrella issue already exists: ${input.umbrellaId}`);
  const timestamp = new Date().toISOString();
  const issue: UmbrellaIssue = {
    schemaVersion: 1,
    umbrellaId: input.umbrellaId,
    title: input.title,
    summary: input.summary ?? '',
    status: 'planned',
    tasks: input.tasks.map((task) => ({
      ...task,
      status: 'planned',
      runIds: [],
      updatedAt: timestamp,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  atomicJson(path, issue);
  return issue;
}

export function getUmbrellaIssue(umbrellaId: string, controllerHome?: string): UmbrellaIssue {
  const path = pathFor(controllerHome, umbrellaId);
  if (!existsSync(path)) throw new Error(`umbrella issue not found: ${umbrellaId}`);
  return JSON.parse(readFileSync(path, 'utf-8')) as UmbrellaIssue;
}

export function listUmbrellaIssues(controllerHome?: string): UmbrellaIssue[] {
  const directory = root(controllerHome);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => getUmbrellaIssue(entry.name.slice(0, -5), controllerHome))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateUmbrellaTask(input: {
  controllerHome?: string;
  umbrellaId: string;
  taskId: string;
  repoId: string;
  status: UmbrellaTaskStatus;
  runId?: string;
  commitSha?: string;
  rollbackRef?: string;
  error?: string;
}): UmbrellaIssue {
  const issue = getUmbrellaIssue(input.umbrellaId, input.controllerHome);
  const index = issue.tasks.findIndex((task) => task.taskId === input.taskId && task.repoId === input.repoId);
  if (index < 0) throw new Error(`umbrella task not found: ${input.repoId}/${input.taskId}`);
  const timestamp = new Date().toISOString();
  const previous = issue.tasks[index];
  issue.tasks[index] = {
    ...previous,
    status: input.status,
    runIds: input.runId && !previous.runIds.includes(input.runId) ? [...previous.runIds, input.runId] : previous.runIds,
    commitSha: input.commitSha ?? previous.commitSha,
    rollbackRef: input.rollbackRef ?? previous.rollbackRef,
    error: input.error,
    updatedAt: timestamp,
  };
  issue.status = deriveStatus(issue.tasks);
  issue.updatedAt = timestamp;
  atomicJson(pathFor(input.controllerHome, input.umbrellaId), issue);
  return issue;
}
