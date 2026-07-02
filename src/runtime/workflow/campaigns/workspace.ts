import { createHash } from 'crypto';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { addRepositoryCheckout, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { withControllerLock } from '../../../cli/repositories/locks';
import { runProcess } from '../../../effects/process-runner';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import type { CampaignWorkspace } from './types';

export interface EnsureCampaignWorkspaceInput {
  requestId: string;
  title: string;
  baseRef?: string;
  branchName?: string;
}

interface CampaignWorkspaceManifest {
  schemaVersion: 1;
  repoId: string;
  requestId: string;
  branch: string;
  path: string;
  baseRevision: string;
  createdAt: string;
}

function suffix(repoId: string, requestId: string): string {
  return createHash('sha256').update(`${repoId}:${requestId}`).digest('hex').slice(0, 12);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 48) || 'automation';
}

function git(root: string, args: string[], timeoutMs = 30_000): string {
  const result = runProcess('git', ['-C', root, ...args], {
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
  if (!result.ok) {
    const detail = result.stderr || result.error || `exit ${result.status}`;
    throw new Error(`CAMPAIGN_WORKSPACE_GIT_FAILED: git ${args.join(' ')}: ${detail}`);
  }
  return result.stdout.trim();
}

function gitSucceeds(root: string, args: string[]): boolean {
  return runProcess('git', ['-C', root, ...args], {
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
  }).ok;
}

function assertBranch(root: string, branch: string): void {
  if (!branch || branch.length > 180 || !gitSucceeds(root, ['check-ref-format', '--branch', branch])) {
    throw new Error(`CAMPAIGN_WORKSPACE_BRANCH_INVALID: ${branch}`);
  }
}

function existingWorkspace(path: string, branch: string): boolean {
  if (!existsSync(path)) return false;
  const root = runProcess('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
  });
  if (!root.ok) throw new Error(`CAMPAIGN_WORKSPACE_PATH_OCCUPIED: ${path}`);
  if (realpathSync(root.stdout.trim()) !== realpathSync(path)) {
    throw new Error(`CAMPAIGN_WORKSPACE_PATH_MISMATCH: ${path}`);
  }
  const currentBranch = git(path, ['branch', '--show-current']);
  if (currentBranch !== branch) {
    throw new Error(`CAMPAIGN_WORKSPACE_BRANCH_MISMATCH: expected ${branch}, found ${currentBranch || 'detached'}`);
  }
  return true;
}

function manifestPath(controllerHome: string, repoId: string, identity: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'campaigns', 'workspaces', `${identity}.json`);
}

export function currentCampaignWorkspace(repository: RepositoryRecord): CampaignWorkspace {
  return {
    mode: 'current',
    checkoutId: repository.activeCheckoutId,
    root: repository.canonicalRoot,
    branch: git(repository.canonicalRoot, ['branch', '--show-current']) || null,
    baseRevision: git(repository.canonicalRoot, ['rev-parse', 'HEAD']),
    managed: false,
  };
}

export function ensureCampaignWorkspace(
  controllerHome: string,
  repository: RepositoryRecord,
  input: EnsureCampaignWorkspaceInput,
): CampaignWorkspace {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error('CAMPAIGN_REQUEST_ID_REQUIRED');
  const identity = suffix(repository.repoId, requestId);
  const sourceRoot = repository.canonicalRoot;
  const requestedBranch = input.branchName?.trim() || `campaign/${slug(input.title)}-${identity}`;
  const requestedBaseRef = input.baseRef?.trim() || 'HEAD';
  assertBranch(sourceRoot, requestedBranch);
  const requestedPath = resolve(join(sourceRoot, '.ai', 'harness', 'worktrees', `campaign-${identity}`));
  const statePath = manifestPath(controllerHome, repository.repoId, identity);

  return withControllerLock(
    controllerHome,
    { scope: 'worktree', repoId: repository.repoId, worktreeId: `campaign-${identity}` },
    `ensure-campaign-workspace:${requestId}`,
    () => {
      const manifest = existsSync(statePath) ? readJsonFile<CampaignWorkspaceManifest>(statePath) : undefined;
      if (manifest && (
        manifest.repoId !== repository.repoId
        || manifest.requestId !== requestId
        || manifest.branch !== requestedBranch
        || resolve(manifest.path) !== requestedPath
      )) {
        throw new Error(`CAMPAIGN_WORKSPACE_REQUEST_CONFLICT: ${requestId}`);
      }
      const branch = manifest?.branch ?? requestedBranch;
      const path = manifest?.path ?? requestedPath;
      const baseRevision = manifest?.baseRevision ?? git(sourceRoot, ['rev-parse', '--verify', `${requestedBaseRef}^{commit}`]);

      if (!existingWorkspace(path, branch)) {
        mkdirSync(dirname(path), { recursive: true });
        const branchExists = gitSucceeds(sourceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        if (branchExists) {
          // A daemon crash may leave stale worktree administration behind even after the directory is gone.
          git(sourceRoot, ['worktree', 'prune', '--expire', 'now'], 120_000);
          git(sourceRoot, ['worktree', 'add', path, branch], 120_000);
        } else {
          git(sourceRoot, ['worktree', 'add', '-b', branch, path, baseRevision], 120_000);
        }
      }

      const record = addRepositoryCheckout({
        repoId: repository.repoId,
        path,
        controllerHome,
        activate: false,
      });
      const checkout = record.checkouts.find((candidate) => realpathSync(candidate.canonicalRoot) === realpathSync(path));
      if (!checkout) throw new Error(`CAMPAIGN_WORKSPACE_CHECKOUT_NOT_REGISTERED: ${path}`);
      const selected = selectRepositoryCheckout(record, checkout.checkoutId);
      if (!manifest) {
        writeJsonAtomic(statePath, {
          schemaVersion: 1,
          repoId: repository.repoId,
          requestId,
          branch,
          path: selected.canonicalRoot,
          baseRevision,
          createdAt: new Date().toISOString(),
        } satisfies CampaignWorkspaceManifest);
      }
      return {
        mode: 'isolated',
        checkoutId: checkout.checkoutId,
        root: selected.canonicalRoot,
        branch,
        baseRevision,
        managed: true,
      } satisfies CampaignWorkspace;
    },
    120_000,
  );
}
