import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import type {
  ControllerAgent,
  ControllerIssue,
  ControllerTask,
  GitHubIssueLink,
  IssueKind,
  IssueReadiness,
  IssueReadinessFinding,
  IssueStatus,
  TaskDraft,
  TaskStatus,
  TaskVerification,
  TaskReadiness,
} from './types';
import { clearCurrentIssue, loadControllerProjectState, saveControllerProjectState } from './project-state';
import { readActiveRunEvidence, readIssueRunEvidence, readTaskRunEvidence } from './run-evidence';
import {
  resolveEffectiveTaskState,
  resolveIssueLifecycleStatus,
  resolveIssueTaskStates,
  resolveTaskDependencies,
} from './task-status-resolver';
import { tryAppendControllerWorklogEvent } from './worklog';
import { executionScopesConflict, taskExecutionPolicy, verificationEvidencePassed } from './execution-policy';
import { listControllerChecks } from './check-runner';
import { normalizeCheckIds } from '../../runtime/control-plane/facade/check-normalization';

const ISSUE_ROOT = 'tasks/issues';
const EPHEMERAL_ISSUE_ROOT = '.ai/harness/ephemeral-issues';
const ISSUE_SUMMARY_NOTE_LIMIT = 2;
const ISSUE_SUMMARY_NOTE_CHARS = 280;
const ISSUE_SUMMARY_RUN_ID_LIMIT = 10;

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'issue';
}

function dateStamp(date = new Date()): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function issueId(): string {
  return `ISS-${dateStamp()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry).trim()).filter(Boolean)));
}

function issueRoot(issue?: Pick<ControllerIssue, 'ephemeral'>): string {
  return issue?.ephemeral ? EPHEMERAL_ISSUE_ROOT : ISSUE_ROOT;
}

function issueFiles(repoRoot: string, includeEphemeral = false): Array<{ root: string; name: string }> {
  const roots = includeEphemeral ? [ISSUE_ROOT, EPHEMERAL_ISSUE_ROOT] : [ISSUE_ROOT];
  return roots.flatMap((root) => {
    const absolute = join(repoRoot, root);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute)
      .filter((name) => name.endsWith('.issue.json'))
      .sort()
      .map((name) => ({ root, name }));
  });
}

function issuePath(repoRoot: string, issue: Pick<ControllerIssue, 'id' | 'slug' | 'ephemeral'>): string {
  const absolute = join(repoRoot, issueRoot(issue), `${issue.id}-${issue.slug}.issue.json`);
  if (issue.ephemeral && absolute.includes(`${sep}tasks${sep}issues${sep}`)) {
    throw new Error(`EPHEMERAL_ISSUE_PATH_INVALID: refused durable path for ephemeral Issue ${issue.id}`);
  }
  return absolute;
}

function markdownPath(repoRoot: string, issue: Pick<ControllerIssue, 'id' | 'slug' | 'ephemeral'>): string {
  const absolute = join(repoRoot, issueRoot(issue), `${issue.id}-${issue.slug}.issue.md`);
  if (issue.ephemeral && absolute.includes(`${sep}tasks${sep}issues${sep}`)) {
    throw new Error(`EPHEMERAL_ISSUE_PATH_INVALID: refused durable path for ephemeral Issue ${issue.id}`);
  }
  return absolute;
}

function renderGitHubLink(link?: GitHubIssueLink): string[] {
  if (!link) return ['- Not published.'];
  return [
    `- Issue: ${link.url}`,
    `- Repository: \`${link.owner}/${link.repo}\``,
    ...(link.projectNumber ? [`- Project: \`${link.projectOwner ?? link.owner}/${link.projectNumber}\``] : []),
    `- Last synced: ${link.syncedAt}`,
  ];
}

function renderIssueMarkdown(issue: ControllerIssue): string {
  const taskLines = issue.tasks.length === 0
    ? ['- No tasks planned yet.']
    : issue.tasks.flatMap((task) => [
      `### ${task.id} — ${task.title}`,
      '',
      `- Status: \`${task.status}\``,
      `- Objective: ${task.objective}`,
      `- Depends on: ${task.dependsOn.length ? task.dependsOn.map((item) => `\`${item}\``).join(', ') : 'none'}`,
      `- Allowed paths: ${task.allowedPaths.length ? task.allowedPaths.map((item) => `\`${item}\``).join(', ') : 'not defined'}`,
      `- Checks: ${task.checks.length ? task.checks.map((item) => `\`${item}\``).join(', ') : 'not defined'}`,
      `- Execution hint: ${task.recommendedAgent ? `agent / ${task.recommendedAgent}` : 'selected at runtime'}`,
      ...(task.github ? [`- GitHub: ${task.github.url}`] : []),
      ...(task.supersededBy?.length ? [`- Superseded by: ${task.supersededBy.map((item) => `\`${item}\``).join(', ')}`] : []),
      '',
    ]);
  return [
    '---',
    `id: ${JSON.stringify(issue.id)}`,
    `kind: ${JSON.stringify(issue.kind)}`,
    `status: ${JSON.stringify(issue.status)}`,
    `updated_at: ${JSON.stringify(issue.updatedAt)}`,
    ...(issue.archivedAt ? [`archived_at: ${JSON.stringify(issue.archivedAt)}`] : []),
    'source: "repo-harness-controller-v8"',
    '---',
    '',
    `# ${issue.title}`,
    '',
    issue.summary || 'No summary provided.',
    '',
    '## Goals',
    '',
    ...(issue.goals.length ? issue.goals.map((item) => `- ${item}`) : ['- TBD']),
    '',
    '## Non-goals',
    '',
    ...(issue.nonGoals.length ? issue.nonGoals.map((item) => `- ${item}`) : ['- None recorded.']),
    '',
    '## Acceptance Criteria',
    '',
    ...(issue.acceptanceCriteria.length ? issue.acceptanceCriteria.map((item) => `- [ ] ${item}`) : ['- [ ] Define issue-level acceptance criteria.']),
    '',
    '## GitHub',
    '',
    ...renderGitHubLink(issue.github),
    '',
    '## Tasks',
    '',
    ...taskLines,
    '## Related Artifacts',
    '',
    ...(issue.relatedArtifacts.length ? issue.relatedArtifacts.map((item) => `- \`${item}\``) : ['- None.']),
    '',
  ].join('\n');
}

function writeIssue(repoRoot: string, issue: ControllerIssue): ControllerIssue {
  const root = join(repoRoot, issueRoot(issue));
  mkdirSync(root, { recursive: true });
  issue.schemaVersion = 5;
  const expectedJson = issuePath(repoRoot, issue);
  const expectedMarkdown = markdownPath(repoRoot, issue);
  for (const name of readdirSync(root)) {
    if (!name.startsWith(`${issue.id}-`)) continue;
    const candidate = join(root, name);
    if (candidate !== expectedJson && candidate !== expectedMarkdown) rmSync(candidate, { force: true });
  }
  writeFileSync(expectedJson, `${JSON.stringify(issue, null, 2)}\n`, 'utf-8');
  writeFileSync(expectedMarkdown, renderIssueMarkdown(issue), 'utf-8');
  const projectState = loadControllerProjectState(repoRoot);
  if (projectState.currentIssueId === issue.id && (issue.archivedAt || ['done', 'cancelled'].includes(issue.status))) {
    clearCurrentIssue(repoRoot, 'issue-terminal-convergence');
  }
  return issue;
}

function normalizeLoadedIssue(issue: ControllerIssue): ControllerIssue {
  issue.schemaVersion = issue.schemaVersion ?? 1;
  issue.tasks = (issue.tasks ?? []).map((task) => ({
    ...task,
    allowedPaths: task.allowedPaths ?? [],
    forbiddenPaths: task.forbiddenPaths ?? [],
    checks: task.checks ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    risk: task.risk ?? 'medium',
    recommendedAgent: task.recommendedAgent,
    notes: task.notes ?? [],
    runIds: task.runIds ?? [],
  }));
  return issue;
}

export function listIssues(repoRoot: string, options: { includeEphemeral?: boolean } = {}): ControllerIssue[] {
  return issueFiles(repoRoot, options.includeEphemeral ?? false)
    .map(({ root, name }) => normalizeLoadedIssue(JSON.parse(readFileSync(join(repoRoot, root, name), 'utf-8')) as ControllerIssue))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getIssue(repoRoot: string, id: string): ControllerIssue {
  const issue = listIssues(repoRoot, { includeEphemeral: true }).find((entry) => entry.id === id);
  if (!issue) throw new Error(`issue not found: ${id}`);
  return issue;
}

export function projectIssueEffectiveView(repoRoot: string, issue: ControllerIssue) {
  const states = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
  return {
    ...issue,
    lifecycleStatus: resolveIssueLifecycleStatus(issue),
    tasks: issue.tasks.map((task) => {
      const state = states.get(task.id)!;
      return {
        ...task,
        declaredStatus: state.declaredStatus,
        effectiveStatus: state.effectiveStatus,
        statusReason: state.reason,
        latestRunId: state.latestRunId,
        latestRunStatus: state.latestRunStatus,
        activeRunId: state.activeRunId,
        activeRunStatus: state.activeRunStatus,
        activeRunIds: state.activeRunIds,
        multipleActiveRuns: state.multipleActiveRuns,
        historicalRunOutcomes: state.historicalRunOutcomes,
        verificationStatus: state.verificationStatus,
        terminal: state.terminal,
        inactive: state.inactive,
        dispatchable: state.dispatchable,
        retryable: state.retryable,
        requiresExplicitRetry: state.requiresExplicitRetry,
        dependencyState: resolveTaskDependencies(issue, task, states),
      };
    }),
  };
}

function summarizeText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function summarizeNotes(notes: string[]): string[] {
  return notes.slice(-ISSUE_SUMMARY_NOTE_LIMIT).map((note) => summarizeText(note, ISSUE_SUMMARY_NOTE_CHARS));
}

function summarizeVerification(verification?: TaskVerification) {
  if (!verification) return undefined;
  return {
    repoId: verification.repoId,
    runId: verification.runId,
    integratedRevision: verification.integratedRevision,
    reviewedDiffHash: verification.reviewedDiffHash,
    checkResults: verification.checkResults,
    acceptanceResults: verification.acceptanceResults.map((result) => ({
      criterion: result.criterion,
      ok: result.ok,
    })),
    acceptanceResultCount: verification.acceptanceResults.length,
    commandEvidenceCount: verification.commandEvidence?.length ?? 0,
    reviewer: verification.reviewer,
    verifiedAt: verification.verifiedAt,
    autoCompleted: verification.autoCompleted,
    detailLevel: 'summary' as const,
  };
}

function summarizeEffectiveTaskView(task: ReturnType<typeof projectIssueEffectiveView>['tasks'][number]) {
  const {
    notes,
    runIds,
    verification,
    historicalRunOutcomes,
    ...rest
  } = task;
  return {
    ...rest,
    notes: summarizeNotes(notes),
    noteCount: notes.length,
    runIds: runIds.slice(-ISSUE_SUMMARY_RUN_ID_LIMIT),
    runIdCount: runIds.length,
    verification: summarizeVerification(verification),
    historicalRunOutcomeCount: historicalRunOutcomes.length,
  };
}

export function getIssueEffectiveView(repoRoot: string, id: string) {
  return projectIssueEffectiveView(repoRoot, getIssue(repoRoot, id));
}

export function getIssueReadView(
  repoRoot: string,
  id: string,
  detailLevel: 'summary' | 'full' = 'summary',
) {
  const full = getIssueEffectiveView(repoRoot, id);
  if (detailLevel === 'full') return { ...full, detailLevel };
  return {
    ...full,
    detailLevel,
    tasks: full.tasks.map(summarizeEffectiveTaskView),
    next: 'Call get_issue with detail_level=full only when full notes, verification evidence, or run history is required.',
  };
}

export function listIssueEffectiveViews(repoRoot: string) {
  return listIssues(repoRoot).map((issue) => projectIssueEffectiveView(repoRoot, issue));
}

function assertIssueExecutionActive(issue: ControllerIssue, operation: string): void {
  const lifecycle = resolveIssueLifecycleStatus(issue);
  if (lifecycle !== 'active') {
    throw new Error(`${operation} is not allowed while Issue ${issue.id} is ${lifecycle}`);
  }
}

function effectiveTaskState(repoRoot: string, issue: ControllerIssue, task: ControllerTask) {
  return resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
}

function nextTaskId(tasks: ControllerTask[]): string {
  const max = tasks.reduce((current, task) => {
    const match = /^T(\d+)$/.exec(task.id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `T${max + 1}`;
}

function taskFromDraft(id: string, draft: TaskDraft, now: string): ControllerTask {
  return {
    id,
    title: String(draft.title ?? '').trim() || id,
    objective: String(draft.objective ?? '').trim() || 'Complete the scoped task.',
    status: (draft.dependsOn?.length ?? 0) > 0 ? 'planned' : 'ready',
    dependsOn: normalizeStrings(draft.dependsOn),
    allowedPaths: normalizeStrings(draft.allowedPaths),
    forbiddenPaths: normalizeStrings(draft.forbiddenPaths),
    checks: normalizeStrings(draft.checks),
    acceptanceCriteria: normalizeStrings(draft.acceptanceCriteria),
    risk: draft.risk ?? 'medium',
    recommendedAgent: draft.recommendedAgent,
    notes: [],
    runIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function validateTaskGraph(tasks: ControllerTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`unknown task dependency: ${task.id} -> ${dependency}`);
      if (dependency === task.id) throw new Error(`task cannot depend on itself: ${task.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`task dependency cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function buildTasks(drafts: TaskDraft[], now = new Date().toISOString()): ControllerTask[] {
  const tasks = drafts.map((draft, index) => taskFromDraft(`T${index + 1}`, draft, now));
  validateTaskGraph(tasks);
  return tasks;
}

type TaskReadinessOptions = {
  approveRisk?: boolean;
  approveDestructive?: boolean;
  retryFromRunId?: string;
  activeRuns?: ReturnType<typeof readActiveRunEvidence>;
};

function buildTaskReadiness(
  repoRoot: string,
  issue: ControllerIssue,
  task: ControllerTask,
  states: ReadonlyMap<string, ReturnType<typeof resolveEffectiveTaskState>>,
  options: TaskReadinessOptions = {},
): TaskReadiness {
  const blockers: IssueReadinessFinding[] = [];
  const warnings: IssueReadinessFinding[] = [];
  const lifecycle = resolveIssueLifecycleStatus(issue);
  const state = states.get(task.id) ?? effectiveTaskState(repoRoot, issue, task);
  const policy = taskExecutionPolicy(task);
  const add = (code: string, level: 'blocker' | 'warning', message: string): void => {
    (level === 'blocker' ? blockers : warnings).push(finding(code, level, message, task.id));
  };

  if (lifecycle !== 'active') add('ISSUE_INACTIVE', 'blocker', `Parent Issue lifecycle is ${lifecycle}.`);
  if (!task.objective.trim()) add('TASK_OBJECTIVE_MISSING', 'blocker', 'Task objective is required.');
  for (const message of policy.warnings) add('TASK_POLICY_WARNING', 'warning', message);
  if (task.risk === 'high' && task.recommendedAgent === 'github-copilot') {
    add('HIGH_RISK_CLOUD_AGENT', 'warning', 'High-risk cloud execution requires explicit review before merge.');
  }
  if (state.multipleActiveRuns) add('MULTIPLE_ACTIVE_RUNS', 'blocker', `Task has multiple active Runs: ${state.activeRunIds.join(', ')}.`);
  else if (state.activeRunIds.length > 0) add('ACTIVE_RUN_CONFLICT', 'blocker', `Task already has active Run evidence: ${state.activeRunIds.join(', ')}.`);

  if (policy.executionClass !== 'read_only' && task.allowedPaths.length > 0) {
    for (const run of options.activeRuns ?? readActiveRunEvidence(repoRoot)) {
      if (run.issueId === issue.id && run.taskId === task.id) continue;
      if (!run.executionClass || !run.allowedPaths) continue;
      if (!executionScopesConflict(
        { executionClass: policy.executionClass, allowedPaths: task.allowedPaths },
        { executionClass: run.executionClass, allowedPaths: run.allowedPaths },
      )) continue;
      add('ACTIVE_SCOPE_CONFLICT', 'blocker', `Declared write scope overlaps active Run ${run.runId} (${run.issueId}/${run.taskId}).`);
    }
  }

  const retryAuthorized = state.requiresExplicitRetry && state.retryable && options.retryFromRunId === state.latestRunId;
  if (state.requiresExplicitRetry && !retryAuthorized) {
    add('EXPLICIT_RETRY_REQUIRED', 'blocker', `Latest Run ${state.latestRunId ?? 'unknown'} requires an explicit retry.`);
  } else if (!state.dispatchable && !retryAuthorized) {
    add('TASK_NOT_DISPATCHABLE', 'blocker', `Effective status ${state.effectiveStatus} is not dispatchable: ${state.reason}`);
  }

  const dependencies = resolveTaskDependencies(issue, task, states);
  for (const id of dependencies.pendingTaskIds) add('PENDING_DEPENDENCY', 'blocker', `Dependency ${id} is not complete.`);
  for (const id of dependencies.cancelledTaskIds) add('CANCELLED_DEPENDENCY', 'blocker', `Dependency ${id} is cancelled or inactive.`);
  for (const id of dependencies.missingTaskIds) add('MISSING_DEPENDENCY', 'blocker', `Dependency ${id} does not exist.`);
  for (const migration of dependencies.supersededMigrations) {
    add('SUPERSEDED_DEPENDENCY_MIGRATION', 'warning', `Dependency ${migration.dependencyTaskId} was superseded by ${migration.replacementTaskIds.join(', ')}; replacement states are authoritative.`);
  }

  if (policy.requiresScopedPaths && task.allowedPaths.length === 0) {
    add('TASK_SCOPE_REQUIRED', 'blocker', `${policy.executionClass} requires an explicit allowed path scope.`);
  }
  if (policy.approval === 'confirm' && !options.approveRisk) {
    add('RISK_CONFIRMATION_ADVISORY', 'warning', `${policy.executionClass} is marked for extra review, but local execution is not approval-gated in V8.`);
  }
  if (policy.approval === 'manual-only' && !options.approveDestructive) {
    add('DESTRUCTIVE_APPROVAL_REQUIRED', 'blocker', 'A destructive or irreversible operation requires explicit authorization.');
  }

  const approvalBlockerCodes = new Set(['DESTRUCTIVE_APPROVAL_REQUIRED']);
  const nonApprovalBlockers = blockers.filter((entry) => !approvalBlockerCodes.has(entry.code));
  const approvalSatisfied = !blockers.some((entry) => approvalBlockerCodes.has(entry.code));
  const score = Math.max(0, 100 - blockers.length * 25 - warnings.length * 3);
  return {
    issueId: issue.id,
    taskId: task.id,
    ready: blockers.length === 0,
    queueable: nonApprovalBlockers.length === 0,
    approvalSatisfied,
    score,
    blockers,
    warnings,
    approval: policy.approval,
    executionClass: policy.executionClass,
    effectiveStatus: state.effectiveStatus,
    requiresExplicitRetry: state.requiresExplicitRetry,
    retryable: state.retryable,
  };
}

export function inspectTaskReadiness(
  repoRoot: string,
  issueIdValue: string,
  taskId: string,
  options: TaskReadinessOptions = {},
): TaskReadiness {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  const states = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
  return buildTaskReadiness(repoRoot, issue, task, states, options);
}

function refreshReadiness(repoRoot: string, issue: ControllerIssue): void {
  if (issue.archivedAt || issue.status === 'cancelled') return;

  const states = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
  const activeRuns = readActiveRunEvidence(repoRoot);
  for (const task of issue.tasks) {
    const state = states.get(task.id)!;
    if (state.terminal || state.inactive || state.requiresExplicitRetry || state.activeRunIds.length > 0) continue;
    if (!['planned', 'ready', 'launch_blocked'].includes(task.status)) continue;
    const readiness = buildTaskReadiness(repoRoot, issue, task, states, {
      // Readiness status reflects executable work, while high-risk confirmation is supplied at dispatch time.
      approveRisk: true,
      approveDestructive: false,
      activeRuns,
    });
    const transitionalBlockerCodes = new Set(['TASK_NOT_DISPATCHABLE']);
    const nonApprovalBlockers = readiness.blockers.filter(
      (entry) => entry.code !== 'DESTRUCTIVE_APPROVAL_REQUIRED' && !transitionalBlockerCodes.has(entry.code),
    );
    task.status = nonApprovalBlockers.length === 0
      ? 'ready'
      : nonApprovalBlockers.some((entry) => ['CANCELLED_DEPENDENCY', 'MISSING_DEPENDENCY', 'TASK_SCOPE_REQUIRED'].includes(entry.code))
        ? 'launch_blocked'
        : 'planned';
  }

  const refreshedStates = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
  const active = issue.tasks.filter((task) => {
    const state = refreshedStates.get(task.id)!;
    return !state.terminal && !state.inactive;
  });
  if (issue.tasks.length > 0 && issue.tasks.every((task) => refreshedStates.get(task.id)?.effectiveStatus === 'done')) issue.status = 'done';
  else if (active.some((task) => ['queued', 'running', 'waiting_for_user', 'review', 'verifying', 'ready_to_integrate', 'integrating', 'integration_blocked', 'integrated', 'cleanup_pending', 'cleanup_blocked', 'changes_requested', 'verified', 'done'].includes(refreshedStates.get(task.id)!.effectiveStatus))) issue.status = 'in_progress';
  else {
    const executable = active.some((task) => buildTaskReadiness(repoRoot, issue, task, refreshedStates, {
      approveRisk: true,
      approveDestructive: true,
      activeRuns,
    }).ready);
    issue.status = executable || active.length > 0 ? 'planned' : 'launch_blocked';
  }
}
export function createIssue(repoRoot: string, input: {
  title: string;
  kind?: IssueKind;
  summary?: string;
  goals?: string[];
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  relatedArtifacts?: string[];
  tasks?: TaskDraft[];
  allowWhileFocused?: boolean;
  allowDuplicate?: boolean;
  allowWhenPaused?: boolean;
  ephemeral?: boolean;
  ephemeralOwnerJobId?: string;
}): ControllerIssue {
  const title = input.title.trim();
  if (!title) throw new Error('issue title is required');
  const projectState = loadControllerProjectState(repoRoot);
  const existingIssues = listIssues(repoRoot);
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
  const duplicate = existingIssues.find((entry) => !entry.archivedAt && !['done', 'cancelled'].includes(entry.status)
    && entry.title.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '') === normalizedTitle);
  // Duplicate and focus signals are governance hints, not execution gates.
  const duplicateHint = !input.ephemeral && duplicate && !input.allowDuplicate ? duplicate.id : undefined;
  if (!input.ephemeral && projectState.issueCreationMode === 'paused' && !input.allowWhenPaused) {
    throw new Error('Issue creation is paused; resume the creation policy or explicitly override it');
  }
  const activeExisting = existingIssues.filter((entry) => !entry.archivedAt && !['done', 'cancelled'].includes(entry.status));
  const focused = projectState.currentIssueId
    ? activeExisting.find((entry) => entry.id === projectState.currentIssueId)
    : undefined;
  // focus_only is retained as a UI preference only. Multiple active Issues do not block creation or execution.
  const now = new Date().toISOString();
  const issue: ControllerIssue = {
    schemaVersion: 5,
    id: issueId(),
    title,
    slug: slugify(title),
    kind: input.kind ?? 'feature',
    status: input.tasks?.length ? 'planned' : 'analysis',
    summary: input.summary?.trim() ?? '',
    goals: normalizeStrings(input.goals),
    nonGoals: normalizeStrings(input.nonGoals),
    acceptanceCriteria: normalizeStrings(input.acceptanceCriteria),
    relatedArtifacts: normalizeStrings(input.relatedArtifacts),
    tasks: buildTasks(input.tasks ?? [], now),
    ...(input.ephemeral ? { ephemeral: true, ephemeralOwnerJobId: input.ephemeralOwnerJobId?.trim() || undefined } : {}),
    createdAt: now,
    updatedAt: now,
  };
  refreshReadiness(repoRoot, issue);
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'issue',
    action: 'issue_created',
    summary: `Created ${issue.id}: ${issue.title}`,
    issueId: issue.id,
    statusTo: issue.status,
    details: {
      kind: issue.kind,
      taskCount: issue.tasks.length,
      creationPolicy: projectState.issueCreationMode,
      policyOverride: Boolean(input.allowWhileFocused || input.allowWhenPaused || input.allowDuplicate),
      ephemeral: Boolean(input.ephemeral),
      duplicateHint,
      focusIsInformational: true,
    },
  });
  if (!input.ephemeral && !focused && activeExisting.length === 0 && !['done', 'cancelled'].includes(issue.status)) {
    saveControllerProjectState(repoRoot, { currentIssueId: issue.id }, 'issue-creation-policy');
  }
  return written;
}

export function planIssue(repoRoot: string, id: string, drafts: TaskDraft[]): ControllerIssue {
  const issue = getIssue(repoRoot, id);
  assertIssueExecutionActive(issue, 'plan_issue');
  if (issue.tasks.some((task) => task.runIds.length > 0)) throw new Error('cannot replace task plan after runs have started; append, split, or supersede Tasks instead');
  const now = new Date().toISOString();
  issue.tasks = buildTasks(drafts, now);
  issue.status = issue.tasks.length ? 'planned' : 'analysis';
  issue.updatedAt = now;
  refreshReadiness(repoRoot, issue);
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, { category: 'issue', action: 'issue_planned', summary: `Replaced the Task plan for ${issue.id} with ${issue.tasks.length} Tasks.`, issueId: issue.id, details: { taskIds: issue.tasks.map((task) => task.id) } });
  return written;
}

export function appendTask(repoRoot: string, issueIdValue: string, draft: TaskDraft): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  assertIssueExecutionActive(issue, 'append_task');
  const now = new Date().toISOString();
  issue.tasks.push(taskFromDraft(nextTaskId(issue.tasks), draft, now));
  validateTaskGraph(issue.tasks);
  issue.updatedAt = now;
  refreshReadiness(repoRoot, issue);
  const task = issue.tasks.at(-1)!;
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, { category: 'task', action: 'task_added', summary: `Added ${task.id}: ${task.title}`, issueId: issue.id, taskId: task.id, statusTo: task.status });
  return written;
}

export function splitTask(repoRoot: string, issueIdValue: string, taskId: string, drafts: TaskDraft[]): ControllerIssue {
  if (drafts.length < 2) throw new Error('split_task requires at least two replacement tasks');
  const issue = getIssue(repoRoot, issueIdValue);
  const original = issue.tasks.find((task) => task.id === taskId);
  const originalStatus = original?.status;
  if (!original) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  assertIssueExecutionActive(issue, 'split_task');
  const originalState = effectiveTaskState(repoRoot, issue, original);
  if (originalState.terminal || originalState.inactive) throw new Error(`cannot split task from effective status ${originalState.effectiveStatus}`);
  if (originalState.activeRunIds.length > 0) throw new Error(`cancel active Run(s) ${originalState.activeRunIds.join(', ')} before splitting this Task`);
  if (['verified'].includes(original.status)) throw new Error(`cannot split task from status ${original.status}`);
  const now = new Date().toISOString();
  const replacements: ControllerTask[] = [];
  for (const draft of drafts) {
    const replacement = taskFromDraft(nextTaskId([...issue.tasks, ...replacements]), {
      ...draft,
      dependsOn: draft.dependsOn ?? original.dependsOn,
      allowedPaths: draft.allowedPaths ?? original.allowedPaths,
      forbiddenPaths: draft.forbiddenPaths ?? original.forbiddenPaths,
      checks: draft.checks ?? original.checks,
      risk: draft.risk ?? original.risk,
      recommendedAgent: draft.recommendedAgent ?? original.recommendedAgent,
    }, now);
    replacements.push(replacement);
  }
  original.status = 'superseded';
  original.supersededBy = replacements.map((task) => task.id);
  original.updatedAt = now;
  for (const task of issue.tasks) {
    if (!task.dependsOn.includes(original.id)) continue;
    task.dependsOn = Array.from(new Set(task.dependsOn.flatMap((dependency) => dependency === original.id ? replacements.map((item) => item.id) : [dependency])));
  }
  issue.tasks.push(...replacements);
  validateTaskGraph(issue.tasks);
  issue.updatedAt = now;
  refreshReadiness(repoRoot, issue);
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, { category: 'task', action: 'task_split', summary: `Split ${taskId} into ${replacements.map((task) => task.id).join(', ')}.`, issueId: issue.id, taskId, statusFrom: originalStatus, statusTo: 'superseded', details: { replacements: replacements.map((task) => task.id) } });
  return written;
}

export function supersedeTask(repoRoot: string, issueIdValue: string, taskId: string, replacementTaskIds: string[] = []): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  assertIssueExecutionActive(issue, 'supersede_task');
  const state = effectiveTaskState(repoRoot, issue, task);
  if (state.terminal || state.inactive) throw new Error(`cannot supersede Task from effective status ${state.effectiveStatus}`);
  if (state.activeRunIds.length > 0) throw new Error(`cancel active Run(s) ${state.activeRunIds.join(', ')} before superseding this Task`);
  for (const replacement of replacementTaskIds) {
    if (!issue.tasks.some((entry) => entry.id === replacement)) throw new Error(`replacement task not found: ${replacement}`);
  }
  const now = new Date().toISOString();
  task.status = 'superseded';
  task.supersededBy = normalizeStrings(replacementTaskIds);
  task.updatedAt = now;
  if (task.supersededBy.length > 0) {
    for (const downstream of issue.tasks) {
      if (!downstream.dependsOn.includes(task.id)) continue;
      downstream.dependsOn = Array.from(new Set(
        downstream.dependsOn.flatMap((dependency) => dependency === task.id ? task.supersededBy! : [dependency]),
      ));
      downstream.updatedAt = now;
    }
  }
  issue.updatedAt = now;
  refreshReadiness(repoRoot, issue);
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, { category: 'task', action: 'task_superseded', summary: `Superseded ${taskId}.`, issueId: issue.id, taskId, statusTo: 'superseded', details: { replacementTaskIds } });
  return written;
}

export function setTaskDependencies(repoRoot: string, issueIdValue: string, taskId: string, dependsOn: string[]): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  assertIssueExecutionActive(issue, 'set_task_dependencies');
  const state = effectiveTaskState(repoRoot, issue, task);
  if (state.terminal || state.inactive) throw new Error(`cannot change dependencies for effective status ${state.effectiveStatus}`);
  task.dependsOn = normalizeStrings(dependsOn);
  validateTaskGraph(issue.tasks);
  task.updatedAt = new Date().toISOString();
  issue.updatedAt = task.updatedAt;
  refreshReadiness(repoRoot, issue);
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, { category: 'task', action: 'task_dependencies_changed', summary: `Updated dependencies for ${taskId}.`, issueId: issue.id, taskId, details: { dependsOn: task.dependsOn } });
  return written;
}

export function updateIssue(repoRoot: string, id: string, patch: {
  title?: string;
  status?: IssueStatus;
  summary?: string;
  goals?: string[];
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  relatedArtifacts?: string[];
  github?: GitHubIssueLink;
}): ControllerIssue {
  const issue = getIssue(repoRoot, id);
  const previousStatus = issue.status;
  if (patch.title !== undefined) {
    issue.title = patch.title.trim() || issue.title;
    issue.slug = slugify(issue.title);
  }
  if (patch.status !== undefined) issue.status = patch.status;
  if (patch.summary !== undefined) issue.summary = patch.summary.trim();
  if (patch.goals !== undefined) issue.goals = normalizeStrings(patch.goals);
  if (patch.nonGoals !== undefined) issue.nonGoals = normalizeStrings(patch.nonGoals);
  if (patch.acceptanceCriteria !== undefined) issue.acceptanceCriteria = normalizeStrings(patch.acceptanceCriteria);
  if (patch.relatedArtifacts !== undefined) issue.relatedArtifacts = normalizeStrings(patch.relatedArtifacts);
  if (patch.github !== undefined) issue.github = patch.github;
  issue.updatedAt = new Date().toISOString();
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: patch.github ? 'github' : 'issue',
    action: patch.github ? 'issue_github_linked' : 'issue_updated',
    summary: patch.status && patch.status !== previousStatus ? `Issue ${issue.id} moved from ${previousStatus} to ${patch.status}.` : `Updated ${issue.id}: ${issue.title}`,
    issueId: issue.id,
    statusFrom: previousStatus,
    statusTo: issue.status,
    details: { fields: Object.keys(patch), githubUrl: patch.github?.url },
  });
  return written;
}

export function updateTask(repoRoot: string, issueIdValue: string, taskId: string, patch: {
  status?: TaskStatus;
  note?: string;
  runId?: string;
  github?: GitHubIssueLink;
  verification?: TaskVerification;
  transition?: 'normal' | 'run_sync' | 'retry' | 'restore';
}): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  const previousStatus = task.status;
  const previousState = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
  if (patch.status && patch.status !== previousStatus) {
    const executableTarget = !['done', 'cancelled', 'superseded'].includes(patch.status);
    if ((task.supersededBy?.length ?? 0) > 0 && patch.status !== 'superseded') {
      throw new Error(`cannot move superseded Task ${task.id} to ${patch.status}; use an explicit replacement/restore operation`);
    }
    if (previousState.issueLifecycleStatus !== 'active' && executableTarget) {
      throw new Error(`cannot move Task ${task.id} to ${patch.status} while parent Issue is ${previousState.issueLifecycleStatus}`);
    }
    if (['done', 'cancelled', 'superseded'].includes(previousStatus) && patch.transition !== 'restore') {
      throw new Error(`explicit terminal Task ${task.id} cannot transition from ${previousStatus} to ${patch.status} without restore/reopen`);
    }
    if (patch.transition === 'run_sync' && (previousState.terminal || previousState.inactive)) {
      throw new Error(`Run reconciliation cannot override effective terminal state ${previousState.effectiveStatus}`);
    }
    task.status = patch.status;
  }
  if (patch.note?.trim()) task.notes.push(patch.note.trim());
  if (patch.runId?.trim() && !task.runIds.includes(patch.runId.trim())) task.runIds.push(patch.runId.trim());
  if (patch.github !== undefined) task.github = patch.github;
  if (patch.verification !== undefined) task.verification = patch.verification;
  task.updatedAt = new Date().toISOString();
  issue.updatedAt = task.updatedAt;
  refreshReadiness(repoRoot, issue);
  const written = writeIssue(repoRoot, issue);
  if (patch.status && patch.status !== previousStatus) {
    tryAppendControllerWorklogEvent(repoRoot, { category: 'task', action: 'task_status_changed', summary: `${task.id} moved from ${previousStatus} to ${task.status}.`, issueId: issue.id, taskId: task.id, statusFrom: previousStatus, statusTo: task.status, details: { title: task.title } });
  }
  if (patch.note?.trim()) tryAppendControllerWorklogEvent(repoRoot, { category: 'task', action: 'task_note_added', summary: patch.note.trim(), issueId: issue.id, taskId: task.id });
  if (patch.runId?.trim()) tryAppendControllerWorklogEvent(repoRoot, { category: 'run', action: 'run_linked_to_task', summary: `Linked ${patch.runId.trim()} to ${task.id}.`, issueId: issue.id, taskId: task.id, runId: patch.runId.trim() });
  if (patch.github) tryAppendControllerWorklogEvent(repoRoot, { category: 'github', action: 'task_github_linked', summary: `Linked ${task.id} to GitHub.`, issueId: issue.id, taskId: task.id, details: { url: patch.github.url } });
  if (patch.verification) tryAppendControllerWorklogEvent(repoRoot, { category: 'verification', action: task.status === 'verified' ? 'verification_passed' : 'verification_recorded', summary: `${task.id} verification recorded by ${patch.verification.reviewer}.`, issueId: issue.id, taskId: task.id, runId: patch.verification.runId, details: { checks: patch.verification.checkResults, acceptance: patch.verification.acceptanceResults } });
  return written;
}

function finding(code: string, level: 'blocker' | 'warning', message: string, taskId?: string): IssueReadinessFinding {
  return { code, level, message, taskId };
}

export function inspectIssueReadiness(repoRoot: string, issueIdValue: string): IssueReadiness {
  const issue = getIssue(repoRoot, issueIdValue);
  const lifecycle = resolveIssueLifecycleStatus(issue);
  const states = resolveIssueTaskStates(issue, readIssueRunEvidence(repoRoot, issue));
  const issueFindings: IssueReadinessFinding[] = [];
  if (lifecycle !== 'active') issueFindings.push(finding('ISSUE_INACTIVE', 'blocker', `Issue lifecycle is ${lifecycle}.`));
  if (!issue.summary.trim()) issueFindings.push(finding('ISSUE_SUMMARY_MISSING', 'warning', 'Issue summary is absent; Task execution remains allowed.'));
  if (issue.goals.length === 0) issueFindings.push(finding('ISSUE_GOALS_MISSING', 'warning', 'Issue has no explicit goals.'));
  if (issue.acceptanceCriteria.length === 0) issueFindings.push(finding('ISSUE_ACCEPTANCE_MISSING', 'warning', 'Issue-level acceptance criteria are absent; Task-local evidence is authoritative.'));
  try { validateTaskGraph(issue.tasks); } catch (error) {
    issueFindings.push(finding(
      'TASK_GRAPH_INVALID',
      'warning',
      `${error instanceof Error ? error.message : String(error)} Task-local dependency findings remain authoritative for launch.`,
    ));
  }

  const activeRuns = readActiveRunEvidence(repoRoot);
  const taskReadiness = issue.tasks
    .filter((task) => {
      const state = states.get(task.id)!;
      return !state.terminal && !state.inactive;
    })
    .map((task) => buildTaskReadiness(repoRoot, issue, task, states, { activeRuns }));
  const readyTasks = taskReadiness.filter((entry) => entry.ready);
  const queueableTasks = taskReadiness.filter((entry) => entry.queueable);
  const agents: Record<ControllerAgent, number> = { codex: 0, claude: 0, 'github-copilot': 0 };
  for (const entry of queueableTasks) {
    const task = issue.tasks.find((candidate) => candidate.id === entry.taskId)!;
    if (task.recommendedAgent) agents[task.recommendedAgent] += 1;
  }
  const taskBlockers = taskReadiness.flatMap((entry) => entry.blockers);
  const taskWarnings = taskReadiness.flatMap((entry) => entry.warnings);
  const issueBlockers = issueFindings.filter((entry) => entry.level === 'blocker');
  // Global blockers are reserved for Issue-wide conditions. Task blockers remain local.
  const blockers = issueBlockers;
  const warnings = [...issueFindings.filter((entry) => entry.level === 'warning'), ...taskWarnings];
  const score = taskReadiness.length === 0
    ? Math.max(0, 100 - issueBlockers.length * 30 - warnings.length * 3)
    : Math.round(taskReadiness.reduce((sum, entry) => sum + entry.score, 0) / taskReadiness.length);
  return {
    issueId: issue.id,
    score,
    // Issue readiness is an aggregate view only; Task-local readiness remains authoritative.
    ready: issueBlockers.length === 0 && readyTasks.length > 0,
    queueable: issueBlockers.length === 0 && queueableTasks.length > 0,
    blockers,
    taskBlockers,
    warnings,
    readyTaskIds: readyTasks.map((entry) => entry.taskId),
    queueableTaskIds: queueableTasks.map((entry) => entry.taskId),
    approvalPendingTaskIds: queueableTasks.filter((entry) => !entry.approvalSatisfied).map((entry) => entry.taskId),
    blockedTaskIds: taskReadiness.filter((entry) => !entry.queueable).map((entry) => entry.taskId),
    taskReadiness,
    suggestedMaxParallel: Math.max(1, Math.min(3, queueableTasks.length || 1)),
    agents,
  };
}
export function removeEphemeralIssue(repoRoot: string, issueIdValue: string): boolean {
  const issue = getIssue(repoRoot, issueIdValue);
  if (!issue.ephemeral) throw new Error(`refusing to remove durable Issue ${issueIdValue}`);
  rmSync(issuePath(repoRoot, issue), { force: true });
  rmSync(markdownPath(repoRoot, issue), { force: true });
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'issue',
    action: 'ephemeral_issue_cleaned',
    summary: `Cleaned ephemeral Issue ${issue.id}.`,
    issueId: issue.id,
  });
  return true;
}

export function archiveIssue(repoRoot: string, issueIdValue: string): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  if (!['done', 'cancelled'].includes(issue.status)) throw new Error(`only done or cancelled Issues can be archived (current: ${issue.status})`);
  if (issue.archivedAt) return issue;
  issue.archivedAt = new Date().toISOString();
  issue.updatedAt = issue.archivedAt;
  const written = writeIssue(repoRoot, issue);
  const projectState = loadControllerProjectState(repoRoot);
  if (projectState.currentIssueId === issue.id) saveControllerProjectState(repoRoot, { currentIssueId: '' }, 'issue-archive');
  tryAppendControllerWorklogEvent(repoRoot, { category: 'issue', action: 'issue_archived', summary: `Archived ${issue.id}: ${issue.title}`, issueId: issue.id, statusFrom: issue.status, statusTo: issue.status });
  return written;
}

export function restoreIssue(repoRoot: string, issueIdValue: string): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  if (!issue.archivedAt) return issue;
  const archivedAt = issue.archivedAt;
  delete issue.archivedAt;
  issue.updatedAt = new Date().toISOString();
  const written = writeIssue(repoRoot, issue);
  tryAppendControllerWorklogEvent(repoRoot, { category: 'issue', action: 'issue_restored', summary: `Restored ${issue.id}: ${issue.title}`, issueId: issue.id, details: { archivedAt } });
  return written;
}

export function acceptVerifiedTask(repoRoot: string, issueIdValue: string, taskId: string, note = 'Accepted after controller verification.'): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  if (task.status === 'done') return issue;
  if (task.status !== 'verified' || !task.verification) throw new Error(`task must have passed required verification before acceptance (current: ${task.status})`);
  const integration = task.verification.integrationEvidence;
  if (!integration?.reachable || !integration.targetBranch.trim() || !integration.targetRevision.trim()) {
    throw new Error('task completion requires persisted integration evidence with a reachable target revision');
  }
  const reachable = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', integration.targetRevision, integration.targetBranch],
    { cwd: repoRoot, encoding: 'utf-8' },
  );
  if (reachable.status !== 0 || reachable.error) {
    throw new Error(`integrated revision ${integration.targetRevision} is not reachable from ${integration.targetBranch}`);
  }
  const cleanup = task.verification.cleanupEvidence;
  const cleanupComplete = cleanup
    && cleanup.worktreeRemovedOrNotCreated
    && cleanup.branchDeletedOrRetained
    && cleanup.leasesReleased
    && cleanup.runTerminal
    && cleanup.editSessionClosedOrNotCreated
    && cleanup.noActiveProcess
    && cleanup.noDirtyDiff;
  if (!cleanupComplete) {
    throw new Error('task completion requires complete cleanup evidence for worktree, branch, leases, Run, edit session, process, and diff');
  }
  return updateTask(repoRoot, issueIdValue, taskId, { status: 'done', note });
}

export function recordTaskVerification(repoRoot: string, issueIdValue: string, taskId: string, verification: TaskVerification): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  const taskState = effectiveTaskState(repoRoot, issue, task);
  if (taskState.terminal || taskState.inactive) throw new Error(`task cannot be verified from effective status ${taskState.effectiveStatus}`);
  if (taskState.activeRunIds.length > 0) throw new Error(`task cannot be verified while Run(s) are active: ${taskState.activeRunIds.join(', ')}`);
  if (!['planned', 'ready', 'launch_blocked', 'review', 'verifying', 'ready_to_integrate', 'integrating', 'integration_blocked', 'integrated', 'cleanup_pending', 'cleanup_blocked', 'changes_requested', 'verified'].includes(task.status)) {
    throw new Error(`task cannot be verified from status ${task.status}`);
  }
  if (!verification.reviewer.trim()) throw new Error('verification reviewer is required');
  if (verification.checkResults.some((entry) => !entry.checkId.trim())) throw new Error('verification check IDs cannot be empty');
  if ((verification.commandEvidence ?? []).some((entry) => entry.command.length === 0 || entry.command.some((part) => !part.trim()))) {
    throw new Error('reported command evidence must contain a non-empty argv');
  }
  const policy = taskExecutionPolicy(task);
  if (policy.requiresScopedPaths && task.allowedPaths.length === 0) {
    throw new Error(`${policy.executionClass} cannot be verified without an explicit allowed path scope`);
  }
  const normalizedDeclaredChecks = normalizeCheckIds(task.checks, listControllerChecks(repoRoot));
  const verificationTask = { ...task, checks: normalizedDeclaredChecks.validCheckIds };
  const outcome = verificationEvidencePassed(verificationTask, verification, policy);
  const successful = outcome.ok;
  // Run-backed verification must stop at verified. Integration and cleanup
  // evidence are finalized by the completion orchestrator before Task done.
  const autoComplete = false;
  const invalidCheckNote = normalizedDeclaredChecks.invalidCheckIds.length > 0
    ? ` Ignored unregistered check id(s): ${normalizedDeclaredChecks.invalidCheckIds.join(', ')}. Invalid check ids are verification infrastructure metadata, not actual check failures.`
    : '';
  verification.autoCompleted = autoComplete;
  return updateTask(repoRoot, issueIdValue, taskId, {
    status: successful ? 'verified' : 'changes_requested',
    verification,
    note: successful
      ? `Required verification evidence passed; integration and cleanup evidence remain required before completion.${invalidCheckNote}`
      : `Verification evidence is incomplete or failed: ${outcome.reasons.join(' ')}${invalidCheckNote}`,
  });
}

export function projectBoard(repoRoot: string): {
  issues: Array<Record<string, unknown>>;
  counts: Record<string, number>;
  declaredCounts: Record<string, number>;
  archivedCounts: Record<string, number>;
  readyTasks: Array<Record<string, string>>;
  queueableTasks: Array<Record<string, string>>;
  currentIssueId?: string;
  archivedIssueCount: number;
} {
  const issues = listIssues(repoRoot);
  const projectState = loadControllerProjectState(repoRoot);
  const currentIssueId = projectState.currentIssueId
    && issues.some((issue) => issue.id === projectState.currentIssueId && !issue.archivedAt && !['done', 'cancelled'].includes(issue.status))
    ? projectState.currentIssueId
    : undefined;
  const counts: Record<string, number> = {};
  const declaredCounts: Record<string, number> = {};
  const archivedCounts: Record<string, number> = {};
  const readyTasks: Array<Record<string, string>> = [];
  const queueableTasks: Array<Record<string, string>> = [];
  const statesByIssue = new Map<string, Map<string, ReturnType<typeof resolveEffectiveTaskState>>>();
  const runsByIssue = new Map<string, Map<string, ReturnType<typeof readTaskRunEvidence>>>();
  const readinessByTask = new Map<string, TaskReadiness>();
  const activeRuns = readActiveRunEvidence(repoRoot);
  for (const issue of issues) {
    const runEvidence = readIssueRunEvidence(repoRoot, issue);
    const states = resolveIssueTaskStates(issue, runEvidence);
    statesByIssue.set(issue.id, states);
    runsByIssue.set(issue.id, runEvidence);
    const targetCounts = issue.archivedAt ? archivedCounts : counts;
    for (const task of issue.tasks) {
      const state = states.get(task.id)!;
      targetCounts[state.effectiveStatus] = (targetCounts[state.effectiveStatus] ?? 0) + 1;
      declaredCounts[state.declaredStatus] = (declaredCounts[state.declaredStatus] ?? 0) + 1;
      const readiness = buildTaskReadiness(repoRoot, issue, task, states, { activeRuns });
      readinessByTask.set(`${issue.id}/${task.id}`, readiness);
      const boardTask = {
        issueId: issue.id,
        taskId: task.id,
        title: task.title,
        agent: task.recommendedAgent ?? "runtime-selected",
        effectiveStatus: state.effectiveStatus,
        executionClass: readiness.executionClass,
        approval: readiness.approval,
      };
      if (readiness.queueable) queueableTasks.push(boardTask);
      if (readiness.ready) readyTasks.push(boardTask);
    }
  }
  return {
    issues: issues.map((issue) => {
      const states = statesByIssue.get(issue.id)!;
      const runEvidence = runsByIssue.get(issue.id)!;
      return {
        id: issue.id,
        title: issue.title,
        kind: issue.kind,
        status: issue.status,
        lifecycleStatus: resolveIssueLifecycleStatus(issue),
        github: issue.github,
        archivedAt: issue.archivedAt,
        updatedAt: issue.updatedAt,
        isCurrent: issue.id === currentIssueId,
        tasks: issue.tasks.map((task) => {
          const state = states.get(task.id)!;
          const readiness = readinessByTask.get(`${issue.id}/${task.id}`)!;
          const latestRun = (runEvidence.get(task.id) ?? []).at(-1);
          return {
            id: task.id,
            title: task.title,
            objective: task.objective,
            allowedPaths: task.allowedPaths,
            forbiddenPaths: task.forbiddenPaths,
            checks: task.checks,
            acceptanceCriteria: task.acceptanceCriteria,
            risk: task.risk,
            status: task.status,
            declaredStatus: state.declaredStatus,
            effectiveStatus: state.effectiveStatus,
            statusReason: state.reason,
            latestRunStatus: state.latestRunStatus,
            latestRunClosureState: latestRun?.closureState ?? 'none',
            activeRunId: state.activeRunId,
            activeRunStatus: state.activeRunStatus,
            activeRunIds: state.activeRunIds,
            multipleActiveRuns: state.multipleActiveRuns,
            verificationStatus: state.verificationStatus,
            dispatchable: readiness.ready,
            queueable: readiness.queueable,
            readiness,
            retryable: state.retryable,
            requiresExplicitRetry: state.requiresExplicitRetry,
            dependsOn: task.dependsOn,
            dependencyState: resolveTaskDependencies(issue, task, states),
            supersededBy: task.supersededBy,
            agent: task.recommendedAgent ?? "runtime-selected",
            runIds: task.runIds,
            github: task.github,
          };
        }),
      };
    }),
    counts,
    declaredCounts,
    archivedCounts,
    // Every active Issue contributes independent Tasks. Current focus is informational only.
    readyTasks,
    queueableTasks,
    currentIssueId,
    archivedIssueCount: issues.filter((issue) => Boolean(issue.archivedAt)).length,
  };
}
