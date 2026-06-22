import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { runProcess } from '../../effects/process-runner';
import { getIssue, updateIssue, updateTask } from '../controller/issue-store';
import type { ControllerIssue, ControllerTask, GitHubIssueLink } from '../controller/types';
import { readTaskRunEvidence } from '../controller/run-evidence';
import { resolveEffectiveTaskState, resolveIssueLifecycleStatus } from '../controller/task-status-resolver';

export interface GitHubRepositoryInfo {
  nameWithOwner: string;
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string;
}

export interface GitHubStatus {
  available: boolean;
  authenticated: boolean;
  version?: string;
  repository?: GitHubRepositoryInfo;
  agentTaskSupported: boolean;
  errors: string[];
}

export interface PublishIssueOptions {
  repo?: string;
  labels?: string[];
  includeTasks?: boolean;
  projectOwner?: string;
  projectNumber?: number;
}

function parseJson<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T; } catch (error) { throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseRepo(value: string): { owner: string; repo: string } {
  const normalized = value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^git@github\.com:/, '');
  const [owner, repo, ...rest] = normalized.split('/');
  if (!owner || !repo || rest.length) throw new Error(`invalid GitHub repository: ${value}`);
  return { owner, repo };
}

function gh(repoRoot: string, args: string[], input?: string, maxOutputBytes = 512 * 1024) {
  return runProcess('gh', args, { cwd: repoRoot, timeoutMs: 120_000, maxOutputBytes, input });
}

export function resolveGitHubRepository(repoRoot: string, explicitRepo?: string): GitHubRepositoryInfo {
  const args = ['repo', 'view'];
  if (explicitRepo?.trim()) args.push(explicitRepo.trim());
  args.push('--json', 'nameWithOwner,url,defaultBranchRef');
  const result = gh(repoRoot, args);
  if (!result.ok) throw new Error(`failed to resolve GitHub repository: ${result.error || result.stderr}`);
  const payload = parseJson<{ nameWithOwner: string; url: string; defaultBranchRef?: { name?: string } }>(result.stdout, 'gh repo view');
  const { owner, repo } = parseRepo(payload.nameWithOwner);
  return {
    nameWithOwner: `${owner}/${repo}`,
    owner,
    repo,
    url: payload.url,
    defaultBranch: payload.defaultBranchRef?.name || 'main',
  };
}

function versionAtLeast(version: string, minimum: [number, number, number]): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export function getGitHubStatus(repoRoot: string, explicitRepo?: string): GitHubStatus {
  const errors: string[] = [];
  const versionResult = gh(repoRoot, ['--version'], undefined, 16 * 1024);
  if (!versionResult.ok) return { available: false, authenticated: false, agentTaskSupported: false, errors: ['GitHub CLI (gh) is not installed or not on PATH.'] };
  const version = versionResult.stdout.split(/\r?\n/)[0] || versionResult.stdout.trim();
  const auth = gh(repoRoot, ['auth', 'status'], undefined, 64 * 1024);
  if (!auth.ok) errors.push(auth.error || auth.stderr || 'GitHub CLI is not authenticated.');
  let repository: GitHubRepositoryInfo | undefined;
  try { repository = resolveGitHubRepository(repoRoot, explicitRepo); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return {
    available: true,
    authenticated: auth.ok,
    version,
    repository,
    agentTaskSupported: versionAtLeast(version, [2, 80, 0]),
    errors,
  };
}

function issueBody(repoRoot: string, issue: ControllerIssue): string {
  return [
    `<!-- repo-harness:${issue.id} -->`,
    issue.summary || 'No summary provided.',
    '',
    '## Goals',
    ...(issue.goals.length ? issue.goals.map((item) => `- ${item}`) : ['- TBD']),
    '',
    '## Non-goals',
    ...(issue.nonGoals.length ? issue.nonGoals.map((item) => `- ${item}`) : ['- None recorded.']),
    '',
    '## Acceptance criteria',
    ...(issue.acceptanceCriteria.length ? issue.acceptanceCriteria.map((item) => `- [ ] ${item}`) : ['- [ ] Define acceptance criteria.']),
    '',
    '## Controller Tasks',
    ...(issue.tasks.filter((task) => resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) }).effectiveStatus !== 'superseded').length
      ? issue.tasks
          .filter((task) => resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) }).effectiveStatus !== 'superseded')
          .map((task) => {
            const state = resolveEffectiveTaskState({ issue, task, runs: readTaskRunEvidence(repoRoot, task) });
            return `- [ ] **${task.id}** — ${task.title} (declared: \`${state.declaredStatus}\`, effective: \`${state.effectiveStatus}\`, run: \`${state.latestRunStatus ?? 'none'}\`, \`${task.recommendedAgent}\`)`;
          })
      : ['- No tasks planned.']),
    '',
    `Local source: \`tasks/issues/${issue.id}-${issue.slug}.issue.md\``,
  ].join('\n');
}

function taskBody(issue: ControllerIssue, task: ControllerTask, parentUrl: string): string {
  return [
    `<!-- repo-harness:${issue.id}/${task.id} -->`,
    `Parent controller issue: ${parentUrl}`,
    '',
    task.objective,
    '',
    '## Scope',
    `- Allowed paths: ${task.allowedPaths.length ? task.allowedPaths.map((item) => `\`${item}\``).join(', ') : 'not defined'}`,
    `- Forbidden paths: ${task.forbiddenPaths.length ? task.forbiddenPaths.map((item) => `\`${item}\``).join(', ') : 'default controller denies'}`,
    `- Risk: \`${task.risk}\``,
    `- Recommended agent: \`${task.recommendedAgent}\``,
    '',
    '## Acceptance criteria',
    ...(task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => `- [ ] ${item}`) : ['- [ ] Define task acceptance criteria.']),
    '',
    '## Checks',
    ...(task.checks.length ? task.checks.map((item) => `- [ ] \`${item}\``) : ['- [ ] Define a focused check or explicitly document manual verification.']),
  ].join('\n');
}

function bodyFile(repoRoot: string, name: string, body: string): string {
  const path = join(repoRoot, '.ai', 'harness', 'github', `${name}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

function parseIssueUrl(output: string): { url: string; number: number } {
  const matches = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)/g);
  const url = matches?.at(-1);
  if (!url) throw new Error(`GitHub CLI did not return an issue URL: ${output.trim()}`);
  const number = Number(url.match(/\/(\d+)$/)?.[1]);
  if (!Number.isFinite(number)) throw new Error(`could not parse issue number from ${url}`);
  return { url, number };
}

function addProjectItem(repoRoot: string, link: GitHubIssueLink, projectOwner?: string, projectNumber?: number): GitHubIssueLink {
  if (!projectOwner || !projectNumber) return link;
  const result = gh(repoRoot, ['project', 'item-add', String(projectNumber), '--owner', projectOwner, '--url', link.url, '--format', 'json']);
  if (!result.ok) throw new Error(`failed to add ${link.url} to GitHub Project: ${result.error || result.stderr}`);
  const payload = result.stdout.trim() ? parseJson<Record<string, unknown>>(result.stdout, 'gh project item-add') : {};
  return {
    ...link,
    projectOwner,
    projectNumber,
    projectItemId: typeof payload.id === 'string' ? payload.id : undefined,
    syncedAt: new Date().toISOString(),
  };
}

function withoutPairedOption(args: string[], option: string): string[] {
  return args.filter((entry, index, all) => entry !== option && all[index - 1] !== option);
}

function createGitHubIssue(repoRoot: string, repo: GitHubRepositoryInfo, title: string, bodyPath: string, labels: string[], parentNumber?: number): GitHubIssueLink {
  const args = ['issue', 'create', '--repo', repo.nameWithOwner, '--title', title, '--body-file', bodyPath];
  for (const label of labels) args.push('--label', label);
  if (parentNumber) args.push('--parent', String(parentNumber));
  let attemptedArgs = args;
  let result = gh(repoRoot, attemptedArgs);
  if (!result.ok && parentNumber) {
    // gh versions before sub-issue support reject --parent. Keep the parent URL in the body and retry.
    attemptedArgs = withoutPairedOption(attemptedArgs, '--parent');
    result = gh(repoRoot, attemptedArgs);
  }
  if (!result.ok && labels.length > 0) {
    // Labels are optional metadata and may not exist in a newly linked repository. Publication must not fail only for that reason.
    attemptedArgs = withoutPairedOption(attemptedArgs, '--label');
    result = gh(repoRoot, attemptedArgs);
  }
  if (!result.ok) throw new Error(`failed to create GitHub issue: ${result.error || result.stderr}`);
  const parsed = parseIssueUrl(result.stdout);
  return { owner: repo.owner, repo: repo.repo, number: parsed.number, url: parsed.url, syncedAt: new Date().toISOString() };
}

function updateGitHubIssue(repoRoot: string, repo: GitHubRepositoryInfo, link: GitHubIssueLink, title: string, bodyPath: string): GitHubIssueLink {
  const result = gh(repoRoot, ['issue', 'edit', String(link.number), '--repo', repo.nameWithOwner, '--title', title, '--body-file', bodyPath]);
  if (!result.ok) throw new Error(`failed to update GitHub issue #${link.number}: ${result.error || result.stderr}`);
  return { ...link, owner: repo.owner, repo: repo.repo, syncedAt: new Date().toISOString() };
}

export function publishIssueToGitHub(repoRoot: string, issueId: string, options: PublishIssueOptions = {}): ControllerIssue {
  let issue = getIssue(repoRoot, issueId);
  const repository = resolveGitHubRepository(repoRoot, options.repo ?? (issue.github ? `${issue.github.owner}/${issue.github.repo}` : undefined));
  const labels = Array.from(new Set(['repo-harness', issue.kind, ...(options.labels ?? [])].filter(Boolean)));
  const parentBody = bodyFile(repoRoot, `${issue.id}-parent`, issueBody(repoRoot, issue));
  try {
    let parent = issue.github
      ? updateGitHubIssue(repoRoot, repository, issue.github, issue.title, parentBody)
      : createGitHubIssue(repoRoot, repository, issue.title, parentBody, labels);
    parent = addProjectItem(repoRoot, parent, options.projectOwner, options.projectNumber);
    issue = updateIssue(repoRoot, issue.id, { github: parent });

    if (options.includeTasks) {
      for (const task of issue.tasks.filter((entry) => resolveEffectiveTaskState({ issue, task: entry, runs: readTaskRunEvidence(repoRoot, entry) }).effectiveStatus !== 'superseded')) {
        const taskFile = bodyFile(repoRoot, `${issue.id}-${task.id}`, taskBody(issue, task, parent.url));
        try {
          let taskLink = task.github
            ? updateGitHubIssue(repoRoot, repository, task.github, `${task.id}: ${task.title}`, taskFile)
            : createGitHubIssue(repoRoot, repository, `${task.id}: ${task.title}`, taskFile, ['repo-harness-task'], parent.number);
          taskLink = addProjectItem(repoRoot, taskLink, options.projectOwner, options.projectNumber);
          issue = updateTask(repoRoot, issue.id, task.id, { github: taskLink, note: `Synced to GitHub: ${taskLink.url}` });
        } finally {
          rmSync(taskFile, { force: true });
        }
      }
    }
    return getIssue(repoRoot, issue.id);
  } finally {
    rmSync(parentBody, { force: true });
  }
}

export function refreshGitHubIssue(repoRoot: string, issueId: string): { issue: ControllerIssue; remote: Record<string, unknown> } {
  const issue = getIssue(repoRoot, issueId);
  if (!issue.github) throw new Error('issue is not linked to GitHub');
  const repository = `${issue.github.owner}/${issue.github.repo}`;
  const result = gh(repoRoot, ['issue', 'view', String(issue.github.number), '--repo', repository, '--json', 'number,title,state,url,labels,assignees,projectItems,updatedAt']);
  if (!result.ok) throw new Error(`failed to refresh GitHub issue: ${result.error || result.stderr}`);
  const remote = parseJson<Record<string, unknown>>(result.stdout, 'gh issue view');
  const state = String(remote.state ?? '').toUpperCase();
  const lifecycle = resolveIssueLifecycleStatus(issue);
  const nextStatus = state === 'CLOSED' && lifecycle === 'active' ? 'review' : issue.status;
  const updated = updateIssue(repoRoot, issue.id, {
    status: nextStatus,
    github: { ...issue.github, url: String(remote.url ?? issue.github.url), syncedAt: new Date().toISOString() },
  });
  return { issue: updated, remote };
}

export function closeGitHubIssue(repoRoot: string, issueId: string): ControllerIssue {
  const issue = getIssue(repoRoot, issueId);
  if (!issue.github) throw new Error('issue is not linked to GitHub');
  const result = gh(repoRoot, ['issue', 'close', String(issue.github.number), '--repo', `${issue.github.owner}/${issue.github.repo}`]);
  if (!result.ok) throw new Error(`failed to close GitHub issue: ${result.error || result.stderr}`);
  return updateIssue(repoRoot, issue.id, { github: { ...issue.github, syncedAt: new Date().toISOString() } });
}

export function githubIssueExists(repoRoot: string, link: GitHubIssueLink): boolean {
  if (!existsSync(repoRoot)) return false;
  const result = gh(repoRoot, ['issue', 'view', String(link.number), '--repo', `${link.owner}/${link.repo}`, '--json', 'number']);
  return result.ok;
}
