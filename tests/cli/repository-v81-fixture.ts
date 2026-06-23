import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stableCheckoutId } from '../../src/cli/repositories/identity';
import type { RepositoryRecord } from '../../src/cli/repositories/types';

export interface RepositoryFixture {
  root: string;
  controllerHome: string;
  repoA: RepositoryRecord;
  repoB: RepositoryRecord;
  cleanup(): void;
}

function record(root: string, repoId: string, name: string): RepositoryRecord {
  const canonicalRoot = join(root, name);
  const checkoutId = stableCheckoutId(repoId, canonicalRoot);
  const timestamp = '2026-06-22T00:00:00.000Z';
  mkdirSync(join(canonicalRoot, 'tasks', 'issues'), { recursive: true });
  mkdirSync(join(canonicalRoot, '.ai', 'harness'), { recursive: true });
  writeFileSync(join(canonicalRoot, 'tasks', 'current.md'), `# ${name}\n`, 'utf-8');
  return {
    schemaVersion: 1,
    repoId,
    displayName: name,
    localRoot: canonicalRoot,
    canonicalRoot,
    activeCheckoutId: checkoutId,
    checkouts: [{
      checkoutId,
      localRoot: canonicalRoot,
      canonicalRoot,
      worktree: false,
      branch: 'main',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    }],
    repositoryType: 'local-git',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: join(canonicalRoot, '.ai', 'harness', 'repository.json'),
    stateStorageStrategy: 'hybrid',
  };
}

export function repositoryFixture(): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-v81-'));
  const controllerHome = join(root, 'controller-home');
  mkdirSync(controllerHome, { recursive: true });
  const repoA = record(root, 'repo_a', 'repo-a');
  const repoB = record(root, 'repo_b', 'repo-b');
  writeFileSync(join(controllerHome, 'repositories.json'), `${JSON.stringify({
    schemaVersion: 1,
    repositories: [repoA, repoB],
    updatedAt: '2026-06-22T00:00:00.000Z',
  }, null, 2)}\n`, 'utf-8');
  return {
    root,
    controllerHome,
    repoA,
    repoB,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
