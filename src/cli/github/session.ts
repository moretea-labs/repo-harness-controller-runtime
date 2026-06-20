import { runProcess } from '../../effects/process-runner';
import { getGitHubStatus, resolveGitHubRepository, type GitHubRepositoryInfo } from './github';

export interface GitHubAgentSession {
  id: string;
  state: string;
  url?: string;
  pullRequestUrl?: string;
  repository: GitHubRepositoryInfo;
  raw: Record<string, unknown>;
}

function parseJson(value: string, label: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch (error) { throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function nestedString(value: unknown, keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' || typeof current === 'number' ? String(current) : undefined;
}

function normalizeSession(repository: GitHubRepositoryInfo, raw: Record<string, unknown>): GitHubAgentSession {
  const id = nestedString(raw, ['id']) ?? nestedString(raw, ['task_id']) ?? nestedString(raw, ['task', 'id']);
  if (!id) throw new Error(`GitHub agent task response did not contain an id: ${JSON.stringify(raw)}`);
  const state = nestedString(raw, ['state']) ?? nestedString(raw, ['status']) ?? nestedString(raw, ['task', 'state']) ?? 'queued';
  return {
    id,
    state,
    url: nestedString(raw, ['html_url']) ?? nestedString(raw, ['url']) ?? nestedString(raw, ['task', 'html_url']),
    pullRequestUrl: nestedString(raw, ['pull_request', 'html_url']) ?? nestedString(raw, ['pull_request_url']) ?? nestedString(raw, ['pullRequest', 'url']),
    repository,
    raw,
  };
}

function ghApi(repoRoot: string, args: string[], input?: string) {
  return runProcess('gh', ['api', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', ...args], {
    cwd: repoRoot,
    timeoutMs: 120_000,
    maxOutputBytes: 1024 * 1024,
    input,
  });
}

export function startGitHubAgentSession(repoRoot: string, input: {
  prompt: string;
  repo?: string;
  baseRef?: string;
  model?: string;
  createPullRequest?: boolean;
}): GitHubAgentSession {
  const status = getGitHubStatus(repoRoot, input.repo);
  if (!status.available || !status.authenticated) {
    throw new Error(`GitHub CLI is not ready for cloud sessions: ${status.errors.join('; ') || 'authenticate with gh auth login'}`);
  }
  if (!status.agentTaskSupported) {
    throw new Error(`GitHub CLI 2.80.0 or later is required for observable Copilot cloud-session logs (current: ${status.version ?? 'unknown'}).`);
  }
  const repository = status.repository ?? resolveGitHubRepository(repoRoot, input.repo);
  const body = JSON.stringify({
    prompt: input.prompt,
    base_ref: input.baseRef ?? repository.defaultBranch,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    create_pull_request: input.createPullRequest !== false,
  });
  const result = ghApi(repoRoot, ['--method', 'POST', `/agents/repos/${repository.owner}/${repository.repo}/tasks`, '--input', '-'], body);
  if (!result.ok) throw new Error(`failed to start GitHub Copilot cloud session: ${result.error || result.stderr}`);
  return normalizeSession(repository, parseJson(result.stdout, 'GitHub agent task API'));
}

export function getGitHubAgentSession(repoRoot: string, owner: string, repo: string, taskId: string): GitHubAgentSession {
  const repository = resolveGitHubRepository(repoRoot, `${owner}/${repo}`);
  const result = ghApi(repoRoot, [`/agents/repos/${owner}/${repo}/tasks/${taskId}`]);
  if (!result.ok) throw new Error(`failed to read GitHub Copilot cloud session ${taskId}: ${result.error || result.stderr}`);
  return normalizeSession(repository, parseJson(result.stdout, 'GitHub agent task API'));
}

export function getGitHubAgentSessionLog(repoRoot: string, owner: string, repo: string, taskId: string, follow = false): string {
  const args = ['agent-task', 'view', '--repo', `${owner}/${repo}`, taskId, '--log'];
  if (follow) args.push('--follow');
  const result = runProcess('gh', args, { cwd: repoRoot, timeoutMs: follow ? 900_000 : 120_000, maxOutputBytes: 2 * 1024 * 1024 });
  if (!result.ok) throw new Error(`failed to read GitHub agent session log: ${result.error || result.stderr}`);
  return result.stdout;
}
