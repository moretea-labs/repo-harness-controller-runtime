import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
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
} from './types';

const ISSUE_ROOT = 'tasks/issues';

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

function issueFiles(repoRoot: string): string[] {
  const root = join(repoRoot, ISSUE_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.endsWith('.issue.json')).sort();
}

function issuePath(repoRoot: string, issue: Pick<ControllerIssue, 'id' | 'slug'>): string {
  return join(repoRoot, ISSUE_ROOT, `${issue.id}-${issue.slug}.issue.json`);
}

function markdownPath(repoRoot: string, issue: Pick<ControllerIssue, 'id' | 'slug'>): string {
  return join(repoRoot, ISSUE_ROOT, `${issue.id}-${issue.slug}.issue.md`);
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
      `- Agent: \`${task.recommendedAgent}\``,
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
    'source: "repo-harness-controller"',
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
  const root = join(repoRoot, ISSUE_ROOT);
  mkdirSync(root, { recursive: true });
  issue.schemaVersion = 2;
  const expectedJson = issuePath(repoRoot, issue);
  const expectedMarkdown = markdownPath(repoRoot, issue);
  for (const name of readdirSync(root)) {
    if (!name.startsWith(`${issue.id}-`)) continue;
    const candidate = join(root, name);
    if (candidate !== expectedJson && candidate !== expectedMarkdown) rmSync(candidate, { force: true });
  }
  writeFileSync(expectedJson, `${JSON.stringify(issue, null, 2)}\n`, 'utf-8');
  writeFileSync(expectedMarkdown, renderIssueMarkdown(issue), 'utf-8');
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
    recommendedAgent: task.recommendedAgent ?? 'codex',
    notes: task.notes ?? [],
    runIds: task.runIds ?? [],
  }));
  return issue;
}

export function listIssues(repoRoot: string): ControllerIssue[] {
  return issueFiles(repoRoot)
    .map((name) => normalizeLoadedIssue(JSON.parse(readFileSync(join(repoRoot, ISSUE_ROOT, name), 'utf-8')) as ControllerIssue))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getIssue(repoRoot: string, id: string): ControllerIssue {
  const issue = listIssues(repoRoot).find((entry) => entry.id === id);
  if (!issue) throw new Error(`issue not found: ${id}`);
  return issue;
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
    recommendedAgent: draft.recommendedAgent ?? 'codex',
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

function refreshReadiness(issue: ControllerIssue): void {
  for (const task of issue.tasks) {
    if (!['planned', 'ready', 'launch_blocked'].includes(task.status)) continue;
    const dependenciesDone = task.dependsOn.every((id) => {
      const dependency = issue.tasks.find((candidate) => candidate.id === id);
      return dependency?.status === 'done' || dependency?.status === 'superseded';
    });
    task.status = dependenciesDone ? 'ready' : 'planned';
  }
  const active = issue.tasks.filter((task) => task.status !== 'superseded');
  if (active.length > 0 && active.every((task) => task.status === 'done')) issue.status = 'done';
  else if (active.some((task) => ['running', 'review', 'integrated', 'verifying', 'changes_requested', 'verified', 'done'].includes(task.status))) issue.status = 'in_progress';
  else if (active.some((task) => task.status === 'launch_blocked')) issue.status = 'launch_blocked';
  else if (active.length > 0) issue.status = 'planned';
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
}): ControllerIssue {
  const title = input.title.trim();
  if (!title) throw new Error('issue title is required');
  const now = new Date().toISOString();
  const issue: ControllerIssue = {
    schemaVersion: 2,
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
    createdAt: now,
    updatedAt: now,
  };
  refreshReadiness(issue);
  return writeIssue(repoRoot, issue);
}

export function planIssue(repoRoot: string, id: string, drafts: TaskDraft[]): ControllerIssue {
  const issue = getIssue(repoRoot, id);
  if (issue.tasks.some((task) => task.runIds.length > 0)) throw new Error('cannot replace task plan after runs have started; append, split, or supersede Tasks instead');
  const now = new Date().toISOString();
  issue.tasks = buildTasks(drafts, now);
  issue.status = issue.tasks.length ? 'planned' : 'analysis';
  issue.updatedAt = now;
  refreshReadiness(issue);
  return writeIssue(repoRoot, issue);
}

export function appendTask(repoRoot: string, issueIdValue: string, draft: TaskDraft): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const now = new Date().toISOString();
  issue.tasks.push(taskFromDraft(nextTaskId(issue.tasks), draft, now));
  validateTaskGraph(issue.tasks);
  issue.updatedAt = now;
  refreshReadiness(issue);
  return writeIssue(repoRoot, issue);
}

export function splitTask(repoRoot: string, issueIdValue: string, taskId: string, drafts: TaskDraft[]): ControllerIssue {
  if (drafts.length < 2) throw new Error('split_task requires at least two replacement tasks');
  const issue = getIssue(repoRoot, issueIdValue);
  const original = issue.tasks.find((task) => task.id === taskId);
  if (!original) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  if (['running', 'done', 'verified'].includes(original.status)) throw new Error(`cannot split task from status ${original.status}`);
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
  refreshReadiness(issue);
  return writeIssue(repoRoot, issue);
}

export function supersedeTask(repoRoot: string, issueIdValue: string, taskId: string, replacementTaskIds: string[] = []): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  if (task.status === 'running') throw new Error('cancel the active Run before superseding this Task');
  for (const replacement of replacementTaskIds) {
    if (!issue.tasks.some((entry) => entry.id === replacement)) throw new Error(`replacement task not found: ${replacement}`);
  }
  const now = new Date().toISOString();
  task.status = 'superseded';
  task.supersededBy = normalizeStrings(replacementTaskIds);
  task.updatedAt = now;
  issue.updatedAt = now;
  refreshReadiness(issue);
  return writeIssue(repoRoot, issue);
}

export function setTaskDependencies(repoRoot: string, issueIdValue: string, taskId: string, dependsOn: string[]): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  task.dependsOn = normalizeStrings(dependsOn);
  validateTaskGraph(issue.tasks);
  task.updatedAt = new Date().toISOString();
  issue.updatedAt = task.updatedAt;
  refreshReadiness(issue);
  return writeIssue(repoRoot, issue);
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
  return writeIssue(repoRoot, issue);
}

export function updateTask(repoRoot: string, issueIdValue: string, taskId: string, patch: {
  status?: TaskStatus;
  note?: string;
  runId?: string;
  github?: GitHubIssueLink;
  verification?: TaskVerification;
}): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  if (patch.status) task.status = patch.status;
  if (patch.note?.trim()) task.notes.push(patch.note.trim());
  if (patch.runId?.trim() && !task.runIds.includes(patch.runId.trim())) task.runIds.push(patch.runId.trim());
  if (patch.github !== undefined) task.github = patch.github;
  if (patch.verification !== undefined) task.verification = patch.verification;
  task.updatedAt = new Date().toISOString();
  issue.updatedAt = task.updatedAt;
  refreshReadiness(issue);
  return writeIssue(repoRoot, issue);
}

function finding(code: string, level: 'blocker' | 'warning', message: string, taskId?: string): IssueReadinessFinding {
  return { code, level, message, taskId };
}

export function inspectIssueReadiness(repoRoot: string, issueIdValue: string): IssueReadiness {
  const issue = getIssue(repoRoot, issueIdValue);
  const findings: IssueReadinessFinding[] = [];
  if (!issue.summary.trim()) findings.push(finding('ISSUE_SUMMARY_MISSING', 'blocker', 'Issue summary is required before launch.'));
  if (issue.goals.length === 0) findings.push(finding('ISSUE_GOALS_MISSING', 'warning', 'Issue has no explicit goals.'));
  if (issue.acceptanceCriteria.length === 0) findings.push(finding('ISSUE_ACCEPTANCE_MISSING', 'blocker', 'Issue-level acceptance criteria are required.'));
  const launchRelevantTasks = issue.tasks.filter((task) => !['done', 'cancelled', 'superseded'].includes(task.status));
  if (launchRelevantTasks.length === 0 && issue.status !== 'done') findings.push(finding('NO_ACTIVE_TASKS', 'blocker', 'Issue has no active Tasks.'));
  for (const task of launchRelevantTasks) {
    if (!task.objective.trim()) findings.push(finding('TASK_OBJECTIVE_MISSING', 'blocker', 'Task objective is required.', task.id));
    if (task.allowedPaths.length === 0) findings.push(finding('TASK_SCOPE_MISSING', task.risk === 'high' ? 'blocker' : 'warning', 'Task has no allowed path scope.', task.id));
    if (task.acceptanceCriteria.length === 0) findings.push(finding('TASK_ACCEPTANCE_MISSING', 'blocker', 'Task acceptance criteria are required.', task.id));
    if (task.checks.length === 0) findings.push(finding('TASK_CHECKS_MISSING', task.risk === 'high' ? 'blocker' : 'warning', 'Task has no named verification checks.', task.id));
    if (task.risk === 'high' && task.recommendedAgent === 'github-copilot') findings.push(finding('HIGH_RISK_CLOUD_AGENT', 'warning', 'High-risk Task is assigned to a GitHub cloud session; require explicit review before merge.', task.id));
  }
  try { validateTaskGraph(issue.tasks); } catch (error) { findings.push(finding('TASK_GRAPH_INVALID', 'blocker', error instanceof Error ? error.message : String(error))); }
  const blockers = findings.filter((entry) => entry.level === 'blocker');
  const warnings = findings.filter((entry) => entry.level === 'warning');
  const readyTasks = issue.tasks.filter((task) => task.status === 'ready');
  const agents: Record<ControllerAgent, number> = { codex: 0, claude: 0, 'github-copilot': 0 };
  for (const task of readyTasks) agents[task.recommendedAgent] += 1;
  const score = Math.max(0, 100 - blockers.length * 20 - warnings.length * 5);
  return {
    issueId: issue.id,
    score,
    ready: blockers.length === 0 && readyTasks.length > 0,
    blockers,
    warnings,
    readyTaskIds: readyTasks.map((task) => task.id),
    suggestedMaxParallel: Math.max(1, Math.min(3, readyTasks.length)),
    agents,
  };
}

export function recordTaskVerification(repoRoot: string, issueIdValue: string, taskId: string, verification: TaskVerification): ControllerIssue {
  const issue = getIssue(repoRoot, issueIdValue);
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issueIdValue}/${taskId}`);
  if (!['review', 'integrated', 'verifying'].includes(task.status)) throw new Error(`task cannot be verified from status ${task.status}`);
  if (!verification.reviewer.trim()) throw new Error('verification reviewer is required');
  if (verification.checkResults.some((entry) => !entry.checkId.trim())) throw new Error('verification check IDs cannot be empty');
  const checksOk = verification.checkResults.length > 0 && verification.checkResults.every((entry) => entry.ok);
  const acceptanceOk = verification.acceptanceResults.every((entry) => entry.ok) && (task.acceptanceCriteria.length === 0
    ? true
    : task.acceptanceCriteria.every((criterion) => verification.acceptanceResults.some((entry) => entry.criterion === criterion && entry.ok)));
  return updateTask(repoRoot, issueIdValue, taskId, {
    status: checksOk && acceptanceOk ? 'verified' : 'changes_requested',
    verification,
    note: checksOk && acceptanceOk ? 'Verification gate passed.' : 'Verification gate failed; changes requested.',
  });
}

export function projectBoard(repoRoot: string): { issues: Array<Record<string, unknown>>; counts: Record<string, number>; readyTasks: Array<Record<string, string>> } {
  const issues = listIssues(repoRoot);
  const counts: Record<string, number> = {};
  const readyTasks: Array<Record<string, string>> = [];
  for (const issue of issues) {
    for (const task of issue.tasks) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      if (task.status === 'ready') readyTasks.push({ issueId: issue.id, taskId: task.id, title: task.title, agent: task.recommendedAgent });
    }
  }
  return {
    issues: issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      kind: issue.kind,
      status: issue.status,
      github: issue.github,
      updatedAt: issue.updatedAt,
      tasks: issue.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        dependsOn: task.dependsOn,
        agent: task.recommendedAgent,
        runIds: task.runIds,
        github: task.github,
      })),
    })),
    counts,
    readyTasks,
  };
}
