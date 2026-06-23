import { createHash, randomUUID } from 'crypto';
import { basename } from 'path';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeRemoteUrl(input: string | undefined): string | undefined {
  const raw = input?.trim();
  if (!raw) return undefined;

  const scpLike = /^(?:([^@\s]+)@)?([^:/\s]+):(.+)$/.exec(raw);
  const expanded = scpLike && !raw.includes('://')
    ? `ssh://${scpLike[1] ? `${scpLike[1]}@` : ''}${scpLike[2]}/${scpLike[3]}`
    : raw;

  try {
    const url = new URL(expanded);
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : '';
    const path = decodeURIComponent(url.pathname)
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+/, '')
      .toLowerCase();
    if (!host || !path) return undefined;
    return `${host}${port}/${path}`;
  } catch (_error) {
    return raw
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  }
}

export function stableRemoteRepoId(canonicalRemote: string): string {
  return `repo_${digest(`remote\0${canonicalRemote}`).slice(0, 24)}`;
}

export function newLocalRepoId(): string {
  return `repo_local_${randomUUID().replace(/-/g, '')}`;
}

export function stableCheckoutId(repoId: string, canonicalRoot: string): string {
  return `checkout_${digest(`${repoId}\0${canonicalRoot}`).slice(0, 24)}`;
}

export function stableWorktreeId(repoId: string, canonicalRoot: string): string {
  return `worktree_${digest(`${repoId}\0${canonicalRoot}`).slice(0, 24)}`;
}

export function parseGitHubRemote(canonicalRemote: string | undefined): { owner: string; repo: string } | undefined {
  if (!canonicalRemote) return undefined;
  const match = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(canonicalRemote);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2] };
}

export function inferDisplayName(root: string, canonicalRemote?: string): string {
  const remoteName = canonicalRemote?.split('/').at(-1)?.trim();
  return remoteName || basename(root) || 'repository';
}
