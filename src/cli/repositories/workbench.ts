import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getRepositoryFocus, listRepositories, repositorySummary, validateRepository } from './registry';
import { ensureRepositoryRuntimeStorage } from './runtime-storage';
import type { RepositoryRecord } from './types';

export interface WorkbenchRunSummary {
  repoId: string;
  checkoutId: string;
  runId: string;
  issueId?: string;
  taskId?: string;
  status?: string;
  executionMode?: string;
  repoRoot: string;
  executionRoot?: string;
  worktreePath?: string;
  branch?: string | null;
  baseRevision?: string | null;
  updatedAt?: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch (_error) {
    return undefined;
  }
}

function listIssues(root: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const directory of [join(root, 'tasks', 'issues'), join(root, '.ai', 'harness', 'ephemeral-issues')]) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.issue.json')) continue;
      const issue = readJson(join(directory, entry.name));
      if (issue) result.push(issue);
    }
  }
  return result;
}

function listRuns(record: RepositoryRecord): WorkbenchRunSummary[] {
  const root = join(record.canonicalRoot, '.ai', 'harness', 'jobs');
  if (!existsSync(root)) return [];
  const result: WorkbenchRunSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readJson(join(root, entry.name, 'meta.json'));
    if (!meta) continue;
    result.push({
      repoId: typeof meta.repoId === 'string' ? meta.repoId : record.repoId,
      checkoutId: typeof meta.checkoutId === 'string' ? meta.checkoutId : record.activeCheckoutId,
      runId: typeof meta.runId === 'string' ? meta.runId : entry.name,
      issueId: typeof meta.issueId === 'string' ? meta.issueId : undefined,
      taskId: typeof meta.taskId === 'string' ? meta.taskId : undefined,
      status: typeof meta.status === 'string' ? meta.status : undefined,
      executionMode: typeof meta.executionMode === 'string' ? meta.executionMode : undefined,
      repoRoot: typeof meta.repoRoot === 'string' ? meta.repoRoot : record.canonicalRoot,
      executionRoot: typeof meta.executionRoot === 'string' ? meta.executionRoot : undefined,
      worktreePath: typeof meta.worktreePath === 'string'
        ? meta.worktreePath
        : typeof meta.worktree === 'string' ? meta.worktree : undefined,
      branch: typeof meta.branch === 'string' || meta.branch === null ? meta.branch as string | null : undefined,
      baseRevision: typeof meta.baseRevision === 'string' || meta.baseRevision === null
        ? meta.baseRevision as string | null
        : undefined,
      updatedAt: typeof meta.finishedAt === 'string'
        ? meta.finishedAt
        : typeof meta.startedAt === 'string'
          ? meta.startedAt
          : typeof meta.createdAt === 'string' ? meta.createdAt : undefined,
    });
  }
  return result.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

function countWorklog(root: string): number {
  for (const path of [
    join(root, '.ai', 'harness', 'controller', 'worklog.jsonl'),
    join(root, '.ai', 'harness', 'worklog.jsonl'),
  ]) {
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path, 'utf-8').split(/\r?\n/).filter((line) => line.trim()).length;
    } catch (_error) {
      return 0;
    }
  }
  return 0;
}

export function buildControllerWorkbench(
  controllerHome: string,
  options: { repoId?: string; includeRemoved?: boolean } = {},
) {
  const records = listRepositories(controllerHome, { includeRemoved: options.includeRemoved === true })
    .filter((record) => !options.repoId || record.repoId === options.repoId);
  if (options.repoId && records.length === 0) throw new Error(`repository not found: ${options.repoId}`);
  const repositories = records.map((record) => {
    const runtimeStorage = ensureRepositoryRuntimeStorage(record, controllerHome);
    const issues = listIssues(record.canonicalRoot);
    const runs = listRuns(record);
    const activeRuns = runs.filter((run) => ['queued', 'running', 'waiting_for_user'].includes(run.status ?? ''));
    return {
      repository: repositorySummary(record),
      health: validateRepository(record.repoId, controllerHome),
      runtimeStorage,
      counts: {
        issues: issues.length,
        tasks: issues.reduce((total, issue) => total + (Array.isArray(issue.tasks) ? issue.tasks.length : 0), 0),
        runs: runs.length,
        activeRuns: activeRuns.length,
        worklogEvents: countWorklog(record.canonicalRoot),
      },
      activeRuns,
    };
  });
  const activeRuns = repositories.flatMap((entry) => entry.activeRuns)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: options.repoId ? 'repository' : 'global',
    selectedRepoId: options.repoId,
    focusRepoId: getRepositoryFocus(controllerHome).repoId,
    repositories,
    activeRuns,
    totals: repositories.reduce((total, entry) => ({
      repositories: total.repositories + 1,
      enabledRepositories: total.enabledRepositories + (entry.repository.enabled ? 1 : 0),
      issues: total.issues + entry.counts.issues,
      tasks: total.tasks + entry.counts.tasks,
      runs: total.runs + entry.counts.runs,
      activeRuns: total.activeRuns + entry.counts.activeRuns,
      worklogEvents: total.worklogEvents + entry.counts.worklogEvents,
    }), { repositories: 0, enabledRepositories: 0, issues: 0, tasks: 0, runs: 0, activeRuns: 0, worklogEvents: 0 }),
  };
}
