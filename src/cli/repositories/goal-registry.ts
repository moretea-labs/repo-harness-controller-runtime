import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { listControllerChecks, runControllerCheck, type ControllerCheckResult } from '../controller/check-runner';
import { repositoryGitStatus } from './structured-git';
import type { RepositoryRecord } from './types';

export interface RepositoryGoal {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'done';
  checks: string[];
  notes?: string;
  updatedAt: string;
  createdAt: string;
  lastRunId?: string;
  lastRunStatus?: RepositoryGoalRun['status'];
}

export interface RepositoryGoalRegistry {
  schemaVersion: 1;
  goals: RepositoryGoal[];
}

export interface RepositoryStuckTrace {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  next: string;
  evidence?: Record<string, unknown>;
}

export interface RepositoryStuckDiagnosis {
  repoId: string;
  checkoutId: string;
  generatedAt: string;
  git: ReturnType<typeof repositoryGitStatus>;
  activeGoals: RepositoryGoal[];
  likelyBlocked: boolean;
  blockers: RepositoryStuckTrace[];
}

export interface RepositoryGoalRun {
  schemaVersion: 1;
  runId: string;
  repoId: string;
  checkoutId: string;
  goalId: string;
  title: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'skipped';
  startedAt: string;
  finishedAt: string;
  gitBefore: ReturnType<typeof repositoryGitStatus>;
  gitAfter: ReturnType<typeof repositoryGitStatus>;
  checks: Array<{
    checkId: string;
    status: 'passed' | 'failed' | 'missing' | 'skipped';
    summary: string;
    artifactPath?: string;
  }>;
  diagnosis: RepositoryStuckDiagnosis;
  next: string[];
}

export interface RepositoryGoalRunResult {
  run: RepositoryGoalRun;
  path: string;
  registry: RepositoryGoalRegistry;
}

const REGISTRY_PATH = '.repo-harness/goals.json';
const RUNS_ROOT = '.repo-harness/goal-runs';
const MAX_RUNS = 100;

function now(): string {
  return new Date().toISOString();
}

function registryPath(repository: RepositoryRecord): string {
  return join(repository.canonicalRoot, REGISTRY_PATH);
}

function runsRoot(repository: RepositoryRecord): string {
  return join(repository.canonicalRoot, RUNS_ROOT);
}

function runPath(repository: RepositoryRecord, runId: string): string {
  return join(runsRoot(repository), `${runId}.json`);
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || `goal-${Date.now()}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export function readRepositoryGoalRegistry(repository: RepositoryRecord): RepositoryGoalRegistry {
  const absolute = registryPath(repository);
  if (!existsSync(absolute)) return { schemaVersion: 1, goals: [] };
  const parsed = JSON.parse(readFileSync(absolute, 'utf-8')) as Partial<RepositoryGoalRegistry>;
  return { schemaVersion: 1, goals: Array.isArray(parsed.goals) ? parsed.goals : [] };
}

function writeRepositoryGoalRegistry(repository: RepositoryRecord, registry: RepositoryGoalRegistry): void {
  writeJson(registryPath(repository), registry);
}

export function upsertRepositoryGoal(repository: RepositoryRecord, input: { id?: unknown; title?: unknown; status?: unknown; checks?: unknown; notes?: unknown }): { path: string; goal: RepositoryGoal; registry: RepositoryGoalRegistry } {
  const registry = readRepositoryGoalRegistry(repository);
  const title = String(input.title ?? '').trim();
  const id = String(input.id ?? '').trim() || slug(title);
  if (!id) throw new Error('REPOSITORY_GOAL_ID_REQUIRED: id or title is required');
  const statusValue = String(input.status ?? 'active');
  const status = (['active', 'paused', 'done'].includes(statusValue) ? statusValue : 'active') as RepositoryGoal['status'];
  const checks = Array.isArray(input.checks) ? input.checks.map((item) => String(item).trim()).filter(Boolean) : [];
  const existing = registry.goals.find((goal) => goal.id === id);
  const at = now();
  const goal: RepositoryGoal = {
    id,
    title: title || existing?.title || id,
    status,
    checks: checks.length > 0 ? checks : existing?.checks ?? [],
    notes: typeof input.notes === 'string' ? input.notes : existing?.notes,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    lastRunId: existing?.lastRunId,
    lastRunStatus: existing?.lastRunStatus,
  };
  registry.goals = [goal, ...registry.goals.filter((entry) => entry.id !== id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  writeRepositoryGoalRegistry(repository, registry);
  return { path: REGISTRY_PATH, goal, registry };
}

function availableCheckIds(repository: RepositoryRecord): Set<string> {
  try { return new Set(listControllerChecks(repository.canonicalRoot).map((check) => check.id)); }
  catch (_error) { return new Set(); }
}

export function diagnoseRepositoryStuckState(repository: RepositoryRecord): RepositoryStuckDiagnosis {
  const generatedAt = now();
  const git = repositoryGitStatus(repository);
  const activeGoals = readRepositoryGoalRegistry(repository).goals.filter((goal) => goal.status === 'active');
  const blockers: RepositoryStuckDiagnosis['blockers'] = [];
  const dirtyLines = git.porcelain.split(/\r?\n/).filter((line) => line && !line.startsWith('## '));
  if (dirtyLines.length > 0) blockers.push({ code: 'DIRTY_WORKTREE', severity: 'warning', message: `${dirtyLines.length} dirty Git path(s) are present.`, next: 'Run repository_git_diff, then repository_git_commit or revert selected paths.', evidence: { staged: git.staged, unstaged: git.unstaged, untracked: git.untracked } });
  if (activeGoals.length === 0) blockers.push({ code: 'NO_ACTIVE_GOAL', severity: 'info', message: 'No active repository goal is registered.', next: 'Create one with repository_goal_upsert so agent work has a durable target.' });
  if (!git.branch) blockers.push({ code: 'DETACHED_HEAD', severity: 'error', message: 'Checkout is not on a named branch.', next: 'Use repository_git_create_branch or repository_git_switch_branch before continuing edits.' });
  const checks = availableCheckIds(repository);
  for (const goal of activeGoals) {
    const missing = goal.checks.filter((check) => !checks.has(check));
    if (missing.length > 0) blockers.push({ code: 'MISSING_GOAL_CHECKS', severity: 'warning', message: `Goal ${goal.id} references missing check(s): ${missing.join(', ')}`, next: 'Update the goal checks or add them to .repo-harness/checks.json/package scripts.', evidence: { goalId: goal.id, missing } });
  }
  return { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, generatedAt, git, activeGoals, likelyBlocked: blockers.some((blocker) => blocker.severity !== 'info'), blockers };
}

function selectedGoal(repository: RepositoryRecord, goalId: unknown): RepositoryGoal | undefined {
  const goals = readRepositoryGoalRegistry(repository).goals;
  const requested = typeof goalId === 'string' ? goalId.trim() : '';
  if (requested) return goals.find((goal) => goal.id === requested);
  return goals.find((goal) => goal.status === 'active');
}

function checkSummary(result: ControllerCheckResult): string {
  return `${result.check.id}: ${result.ok ? 'passed' : 'failed'} (${result.status}${result.timedOut ? ', timed out' : ''})`;
}

function pruneRuns(repository: RepositoryRecord): void {
  const root = runsRoot(repository);
  if (!existsSync(root)) return;
  const files = readdirSync(root).filter((name) => name.endsWith('.json')).sort().reverse();
  for (const file of files.slice(MAX_RUNS)) {
    try { writeFileSync(join(root, file), readFileSync(join(root, file))); }
    catch (_error) { /* best effort no-op; avoid destructive cleanup here */ }
  }
}

export function runRepositoryGoal(repository: RepositoryRecord, input: { goalId?: unknown; runChecks?: unknown } = {}): RepositoryGoalRunResult {
  const goal = selectedGoal(repository, input.goalId);
  if (!goal) throw new Error('REPOSITORY_GOAL_NOT_FOUND: no active or requested goal exists');
  if (goal.status !== 'active') throw new Error(`REPOSITORY_GOAL_NOT_ACTIVE: ${goal.id} is ${goal.status}`);
  const startedAt = now();
  const runId = `GOAL-${Date.now()}-${goal.id.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48)}`;
  const gitBefore = repositoryGitStatus(repository);
  const diagnosis = diagnoseRepositoryStuckState(repository);
  const checks: RepositoryGoalRun['checks'] = [];
  const knownChecks = availableCheckIds(repository);
  if (goal.checks.length === 0) {
    checks.push({ checkId: '(none)', status: 'skipped', summary: 'Goal has no checks configured.' });
  } else if (input.runChecks !== true) {
    checks.push(...goal.checks.map((checkId) => ({ checkId, status: 'skipped' as const, summary: 'Checks were not executed; pass run_checks=true to run them.' })));
  } else {
    for (const checkId of goal.checks) {
      if (!knownChecks.has(checkId)) {
        checks.push({ checkId, status: 'missing', summary: `Check not found: ${checkId}` });
        continue;
      }
      try {
        const check = runControllerCheck(repository.canonicalRoot, checkId);
        checks.push({ checkId, status: check.ok ? 'passed' : 'failed', summary: checkSummary(check), artifactPath: check.artifactPath });
      } catch (error) {
        checks.push({ checkId, status: 'failed', summary: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const gitAfter = repositoryGitStatus(repository);
  const hardBlockers = diagnosis.blockers.filter((blocker) => blocker.severity === 'error');
  const failedChecks = checks.filter((check) => check.status === 'failed' || check.status === 'missing');
  const status: RepositoryGoalRun['status'] = hardBlockers.length > 0 ? 'blocked' : failedChecks.length > 0 ? 'failed' : 'succeeded';
  const finishedAt = now();
  const next = [
    ...diagnosis.blockers.map((blocker) => blocker.next),
    ...(failedChecks.length > 0 ? ['Inspect failed check artifacts, patch the failures, and re-run repository_goal_run.'] : []),
    ...(gitAfter.clean ? ['No dirty worktree changes remain after this goal run.'] : ['Review repository_git_diff and commit or revert current changes.']),
  ];
  const run: RepositoryGoalRun = { schemaVersion: 1, runId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, goalId: goal.id, title: goal.title, status, startedAt, finishedAt, gitBefore, gitAfter, checks, diagnosis, next: [...new Set(next)] };
  writeJson(runPath(repository, runId), run);
  const registry = readRepositoryGoalRegistry(repository);
  registry.goals = registry.goals.map((entry) => entry.id === goal.id ? { ...entry, lastRunId: runId, lastRunStatus: status, updatedAt: finishedAt } : entry);
  writeRepositoryGoalRegistry(repository, registry);
  pruneRuns(repository);
  return { run, path: `${RUNS_ROOT}/${runId}.json`, registry };
}

export function listRepositoryGoalRuns(repository: RepositoryRecord, limit = 20): RepositoryGoalRun[] {
  const root = runsRoot(repository);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(Math.trunc(limit), MAX_RUNS)))
    .flatMap((name) => {
      try { return [JSON.parse(readFileSync(join(root, name), 'utf-8')) as RepositoryGoalRun]; }
      catch (_error) { return []; }
    });
}
