import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import {
  repositoryCheckoutLifecycle,
  selectRepositoryCheckout,
} from '../../cli/repositories/registry';
import {
  repositoryGitStatus,
  type RepositoryGitStatusSnapshot,
} from '../../cli/repositories/structured-git';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export interface RepositoryGitStatusSample extends RepositoryGitStatusSnapshot {
  sampleSource: 'daemon-sample';
  sampledBy: 'scheduler';
}

function samplePath(controllerHome: string, repoId: string, checkoutId: string): string {
  return join(
    repositoryControllerRoot(controllerHome, repoId),
    'projections',
    'git-status',
    `${sanitizeFileComponent(checkoutId)}.json`,
  );
}

export function writeRepositoryGitStatusSample(
  controllerHome: string,
  repository: RepositoryRecord,
): RepositoryGitStatusSample {
  const live = repositoryGitStatus(repository);
  const sample: RepositoryGitStatusSample = {
    ...live,
    sampleSource: 'daemon-sample',
    staleAgeMs: 0,
    sampledBy: 'scheduler',
  };
  writeJsonAtomic(samplePath(controllerHome, sample.repoId, sample.checkoutId), sample);
  return sample;
}

export function readRepositoryGitStatusSample(
  controllerHome: string,
  repoId: string,
  checkoutId: string,
): RepositoryGitStatusSample | undefined {
  try {
    const sample = readJsonFile<RepositoryGitStatusSample>(samplePath(controllerHome, repoId, checkoutId));
    const observedMs = Date.parse(sample.observedAt);
    return {
      ...sample,
      sampleSource: 'daemon-sample',
      staleAgeMs: Number.isFinite(observedMs) ? Math.max(0, Date.now() - observedMs) : Number.POSITIVE_INFINITY,
      sampledBy: 'scheduler',
    };
  } catch {
    return undefined;
  }
}

export function sampleRepositoryGitStatusForRepositories(
  controllerHome: string,
  repositories: RepositoryRecord[],
): { sampled: number; failed: Array<{ repoId: string; checkoutId: string; message: string }> } {
  let sampled = 0;
  const failed: Array<{ repoId: string; checkoutId: string; message: string }> = [];
  for (const repository of repositories) {
    for (const checkout of repository.checkouts) {
      if (repositoryCheckoutLifecycle(checkout) !== 'active') continue;
      try {
        writeRepositoryGitStatusSample(controllerHome, selectRepositoryCheckout(repository, checkout.checkoutId));
        sampled += 1;
      } catch (error) {
        failed.push({
          repoId: repository.repoId,
          checkoutId: checkout.checkoutId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { sampled, failed };
}
