import { randomBytes } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { startTaskJob } from '../agent-jobs/job-manager';
import { createIssue, getIssue } from '../controller/issue-store';
import { runControllerCheck } from '../controller/check-runner';
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS, normalizeAgentTimeoutMs } from '../controller/runtime-config';
import { loadMcpLocalConfig } from '../mcp/auth';
import type { ControllerAgent, ControllerTask } from '../controller/types';
import type {
  LaunchTaskPayload,
  LocalBridgeApproval,
  LocalBridgeConfig,
  LocalBridgeJob,
  LocalBridgeJobAction,
  LocalBridgeJobEvent,
  LocalBridgeJobRequest,
  QuickAgentSessionPayload,
  RunCheckPayload,
} from './types';

const JOB_ROOT = '.ai/harness/local-jobs';
const CONFIG_PATH = '.repo-harness/local-bridge.json';

function now(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomBytes(4).toString('hex');
}

function jobDir(repoRoot: string, jobId: string): string {
  return join(repoRoot, JOB_ROOT, jobId);
}

function metaPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), 'job.json');
}

function eventsPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), 'events.jsonl');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry).trim()).filter(Boolean)));
}

function appendEvent(repoRoot: string, jobId: string, event: Omit<LocalBridgeJobEvent, 'at'>): void {
  const path = eventsPath(repoRoot, jobId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ...event, at: now() })}\n`, 'utf-8');
}

export function loadLocalBridgeConfig(repoRoot: string): LocalBridgeConfig {
  const path = join(repoRoot, CONFIG_PATH);
  if (!existsSync(path)) return { version: 1 };
  try {
    const parsed = readJson<LocalBridgeConfig>(path);
    return { version: 1, ...parsed };
  } catch (_error) {
    return { version: 1 };
  }
}

export function localBridgeTimeoutPolicy(repoRoot: string): { defaultTimeoutMs: number; maxTimeoutMs: number } {
  const local = loadLocalBridgeConfig(repoRoot);
  const mcp = loadMcpLocalConfig(repoRoot);
  const maxTimeoutMs = normalizeAgentTimeoutMs(
    local.maxTimeoutMs ?? mcp?.devMode?.maxTimeoutMs,
    { defaultMs: MAX_AGENT_TIMEOUT_MS, maxMs: MAX_AGENT_TIMEOUT_MS, label: 'local bridge max timeout' },
  );
  const defaultTimeoutMs = normalizeAgentTimeoutMs(
    local.defaultTimeoutMs ?? mcp?.devMode?.timeoutMs,
    { defaultMs: DEFAULT_AGENT_TIMEOUT_MS, maxMs: maxTimeoutMs, label: 'local bridge default timeout' },
  );
  return { defaultTimeoutMs, maxTimeoutMs };
}

function resolvedJobTimeout(repoRoot: string, value: unknown): number {
  const policy = localBridgeTimeoutPolicy(repoRoot);
  return normalizeAgentTimeoutMs(value, { defaultMs: policy.defaultTimeoutMs, maxMs: policy.maxTimeoutMs });
}

function taskApproval(task: ControllerTask, isolate = true): LocalBridgeApproval {
  if (!isolate || task.risk === 'high' || task.allowedPaths.length === 0) return 'confirm';
  return 'auto';
}

function stricterApproval(left: LocalBridgeApproval, right: LocalBridgeApproval): LocalBridgeApproval {
  const rank: Record<LocalBridgeApproval, number> = { auto: 0, confirm: 1, 'manual-only': 2 };
  return rank[left] >= rank[right] ? left : right;
}

function defaultApproval(repoRoot: string, action: LocalBridgeJobAction, payload: LocalBridgeJobRequest['payload']): LocalBridgeApproval {
  const configured = loadLocalBridgeConfig(repoRoot).approvals?.[action];
  if (configured) return configured;
  if (action === 'run-check') return 'auto';
  if (action === 'launch-task') {
    const input = payload as LaunchTaskPayload;
    const issue = getIssue(repoRoot, input.issueId);
    const task = issue.tasks.find((entry) => entry.id === input.taskId);
    if (!task) throw new Error(`task not found: ${input.issueId}/${input.taskId}`);
    return taskApproval(task, input.isolate !== false);
  }
  const input = payload as QuickAgentSessionPayload;
  return input.risk === 'high' || input.isolate === false || normalizeStringList(input.allowedPaths).length === 0 ? 'confirm' : 'auto';
}

function assertApproval(value: string): asserts value is LocalBridgeApproval {
  if (!['auto', 'confirm', 'manual-only'].includes(value)) throw new Error(`invalid local bridge approval: ${value}`);
}

export function submitLocalBridgeJob(repoRoot: string, request: LocalBridgeJobRequest): LocalBridgeJob {
  if (!['launch-task', 'quick-agent-session', 'run-check'].includes(request.action)) {
    throw new Error(`unsupported local bridge action: ${String(request.action)}`);
  }
  const policyApproval = defaultApproval(repoRoot, request.action, request.payload);
  const requestedApproval = request.approval ?? policyApproval;
  assertApproval(requestedApproval);
  const approval = stricterApproval(policyApproval, requestedApproval);
  const createdAt = now();
  const job: LocalBridgeJob = {
    schemaVersion: 1,
    jobId: `JOB-${Date.now()}-${shortId()}`,
    action: request.action,
    payload: request.payload,
    requestedBy: request.requestedBy?.trim() || 'local-user',
    approval,
    status: approval === 'auto' ? 'approved' : 'pending_approval',
    createdAt,
    updatedAt: createdAt,
    ...(approval === 'auto' ? { approvedAt: createdAt } : {}),
  };
  writeJson(metaPath(repoRoot, job.jobId), job);
  appendEvent(repoRoot, job.jobId, { type: 'job_created', message: `${job.action} job created with ${approval} approval.` });
  if (approval === 'auto') appendEvent(repoRoot, job.jobId, { type: 'job_approved', message: 'Automatically approved by local policy.' });
  return job;
}

export function getLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  const path = metaPath(repoRoot, jobId);
  if (!existsSync(path)) throw new Error(`local bridge job not found: ${jobId}`);
  return readJson<LocalBridgeJob>(path);
}

export function listLocalBridgeJobs(repoRoot: string, limit = 100): LocalBridgeJob[] {
  const root = join(repoRoot, JOB_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'job.json')))
    .map((entry) => readJson<LocalBridgeJob>(join(root, entry.name, 'job.json')))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

export function getLocalBridgeJobEvents(repoRoot: string, jobId: string): LocalBridgeJobEvent[] {
  getLocalBridgeJob(repoRoot, jobId);
  const path = eventsPath(repoRoot, jobId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LocalBridgeJobEvent);
}

function saveJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob {
  job.updatedAt = now();
  writeJson(metaPath(repoRoot, job.jobId), job);
  return job;
}

export function approveLocalBridgeJob(repoRoot: string, jobId: string, allowManualOnly = false): LocalBridgeJob {
  const job = getLocalBridgeJob(repoRoot, jobId);
  if (job.approval === 'manual-only' && !allowManualOnly) throw new Error('manual-only jobs must be approved from the localhost visual controller');
  if (!['pending_approval', 'approved'].includes(job.status)) return job;
  job.status = 'approved';
  job.approvedAt = job.approvedAt ?? now();
  appendEvent(repoRoot, job.jobId, { type: 'job_approved', message: 'Approved from the local control surface.' });
  return saveJob(repoRoot, job);
}

export function cancelLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  const job = getLocalBridgeJob(repoRoot, jobId);
  if (['succeeded', 'failed', 'cancelled', 'dispatched'].includes(job.status)) return job;
  job.status = 'cancelled';
  job.finishedAt = now();
  appendEvent(repoRoot, job.jobId, { type: 'job_cancelled', message: 'Cancelled before execution.' });
  return saveJob(repoRoot, job);
}

function normalizeAgent(value: ControllerAgent | undefined): ControllerAgent {
  return value ?? 'codex';
}

function executeLaunchTask(repoRoot: string, job: LocalBridgeJob, payload: LaunchTaskPayload): void {
  const run = startTaskJob({
    repoRoot,
    issueId: payload.issueId,
    taskId: payload.taskId,
    agent: normalizeAgent(payload.agent),
    timeoutMs: resolvedJobTimeout(repoRoot, payload.timeoutMs),
    isolate: payload.isolate !== false,
    githubRepo: payload.githubRepo,
    baseRef: payload.baseRef,
    model: payload.model,
    createPullRequest: payload.createPullRequest,
  });
  job.runId = run.runId;
  job.issueId = payload.issueId;
  job.taskId = payload.taskId;
  job.status = 'dispatched';
  job.finishedAt = now();
  job.result = { runId: run.runId, provider: run.provider, status: run.status, worktree: run.worktree, github: run.github };
  appendEvent(repoRoot, job.jobId, { type: 'job_dispatched', message: `Task dispatched as ${run.runId}.`, data: { runId: run.runId } });
}

function executeQuickSession(repoRoot: string, job: LocalBridgeJob, payload: QuickAgentSessionPayload): void {
  const title = payload.title?.trim();
  const objective = payload.objective?.trim();
  if (!title || !objective) throw new Error('quick-agent-session requires title and objective');
  const acceptance = normalizeStringList(payload.acceptanceCriteria);
  const issue = createIssue(repoRoot, {
    title,
    kind: 'investigation',
    summary: payload.summary?.trim() || objective,
    goals: [objective],
    nonGoals: ['Do not make unrelated changes outside the declared Task scope.'],
    acceptanceCriteria: acceptance.length ? acceptance : [`Complete: ${objective}`],
    tasks: [{
      title,
      objective,
      allowedPaths: normalizeStringList(payload.allowedPaths),
      forbiddenPaths: normalizeStringList(payload.forbiddenPaths),
      checks: normalizeStringList(payload.checks),
      acceptanceCriteria: acceptance.length ? acceptance : [`Complete: ${objective}`],
      risk: payload.risk ?? 'low',
      recommendedAgent: payload.agent ?? 'codex',
    }],
  });
  const task = issue.tasks[0];
  if (!task) throw new Error('quick session issue was created without a Task');
  const run = startTaskJob({
    repoRoot,
    issueId: issue.id,
    taskId: task.id,
    agent: payload.agent ?? 'codex',
    timeoutMs: resolvedJobTimeout(repoRoot, payload.timeoutMs),
    isolate: payload.isolate !== false,
  });
  job.runId = run.runId;
  job.issueId = issue.id;
  job.taskId = task.id;
  job.status = 'dispatched';
  job.finishedAt = now();
  job.result = { issueId: issue.id, taskId: task.id, runId: run.runId, provider: run.provider, worktree: run.worktree };
  appendEvent(repoRoot, job.jobId, { type: 'job_dispatched', message: `Quick session dispatched as ${run.runId}.`, data: { issueId: issue.id, taskId: task.id, runId: run.runId } });
}

function executeRunCheck(repoRoot: string, job: LocalBridgeJob, payload: RunCheckPayload): void {
  const result = runControllerCheck(repoRoot, payload.checkId, payload.timeoutMs);
  job.status = result.ok ? 'succeeded' : 'failed';
  job.finishedAt = now();
  job.result = result as unknown as Record<string, unknown>;
  if (!result.ok) job.error = result.stderr || `check failed: ${payload.checkId}`;
  appendEvent(repoRoot, job.jobId, {
    type: result.ok ? 'job_succeeded' : 'job_failed',
    message: result.ok ? `Check ${payload.checkId} passed.` : `Check ${payload.checkId} failed.`,
  });
}

export function executeLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  const job = getLocalBridgeJob(repoRoot, jobId);
  if (job.status === 'pending_approval') throw new Error('job requires local approval before execution');
  if (job.approval === 'manual-only' && !job.approvedAt) throw new Error('manual-only job requires localhost visual approval');
  if (!['approved'].includes(job.status)) return job;
  job.status = 'running';
  job.startedAt = now();
  saveJob(repoRoot, job);
  appendEvent(repoRoot, job.jobId, { type: 'job_started', message: `${job.action} execution started.` });
  try {
    if (job.action === 'launch-task') executeLaunchTask(repoRoot, job, job.payload as LaunchTaskPayload);
    else if (job.action === 'quick-agent-session') executeQuickSession(repoRoot, job, job.payload as QuickAgentSessionPayload);
    else executeRunCheck(repoRoot, job, job.payload as RunCheckPayload);
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = now();
    appendEvent(repoRoot, job.jobId, { type: 'job_failed', message: job.error });
  }
  return saveJob(repoRoot, job);
}

export function approveAndExecuteLocalBridgeJob(repoRoot: string, jobId: string, allowManualOnly = false): LocalBridgeJob {
  approveLocalBridgeJob(repoRoot, jobId, allowManualOnly);
  return executeLocalBridgeJob(repoRoot, jobId);
}
