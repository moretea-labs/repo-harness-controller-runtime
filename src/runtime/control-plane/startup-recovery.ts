import { existsSync } from 'fs';
import { join } from 'path';
import { listRepositories, reconcileRepositoryCheckouts } from '../../cli/repositories/registry';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { listLocalBridgeJobs, reconcileLocalBridgeJobs } from '../../cli/local-bridge/job-store';
import { listExecutionJobs, rebuildExecutionJobIndexes } from '../execution/jobs/store';
import { reconcileExecutionJobs } from './global-scheduler/reconciliation';
import { listActiveLeases } from '../resources/leases/store';
import { rebuildRepositoryProjection } from '../projections/materialized-view';
import { readRepositoryProjectionDirty } from '../projections/invalidation';
import { CONTROLLER_SCOPE_REPO_ID } from '../../cli/repositories/controller-home';
import { reconcileStaleWorkContracts } from './facade/work-contract-store';

export interface ControllerRecoveryError {
  repoId: string;
  phase: 'checkouts' | 'execution-indexes' | 'execution-jobs' | 'local-jobs' | 'leases' | 'work-contracts' | 'projection';
  code: string;
  message: string;
}

export interface ControllerRecoveryRepositoryResult {
  repoId: string;
  degraded: boolean;
  archivedCheckoutIds?: string[];
  executionIndexesRebuilt?: boolean;
  executionJobs?: ReturnType<typeof reconcileExecutionJobs>;
  localJobs?: ReturnType<typeof reconcileLocalBridgeJobs>;
  activeLeases?: number;
  workContracts?: ReturnType<typeof reconcileStaleWorkContracts>;
  projectionRebuilt?: boolean;
}

export interface ControllerStartupRecoveryResult {
  completedAt: string;
  repositories: ControllerRecoveryRepositoryResult[];
  errors: ControllerRecoveryError[];
  degraded: boolean;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(':');
  return separator > 0 ? message.slice(0, separator) : 'RECOVERY_FAILED';
}

function persistedProjectionExists(controllerHome: string, repoId: string): boolean {
  return existsSync(join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'runtime.json'));
}

function projectionNeedsRebuild(controllerHome: string, repoId: string): boolean {
  return !persistedProjectionExists(controllerHome, repoId)
    || readRepositoryProjectionDirty(controllerHome, repoId) !== undefined;
}

/**
 * Synchronous, repository-isolated restart reconciliation. Every operation is
 * bounded by the underlying durable-store scans; one repository failure is
 * recorded and cannot prevent healthy repositories from becoming ready.
 */
export function reconcileControllerStartup(controllerHome: string): ControllerStartupRecoveryResult {
  const repositories = listRepositories(controllerHome).filter((repo) => repo.enabled && !repo.removedAt);
  const recovered: ControllerRecoveryRepositoryResult[] = [];
  const errors: ControllerRecoveryError[] = [];
  for (const repository of repositories) {
    const result: ControllerRecoveryRepositoryResult = { repoId: repository.repoId, degraded: false };
    const run = <T>(phase: ControllerRecoveryError['phase'], action: () => T): T | undefined => {
      try {
        return action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.degraded = true;
        errors.push({ repoId: repository.repoId, phase, code: errorCode(error), message });
        return undefined;
      }
    };

    result.archivedCheckoutIds = run('checkouts', () =>
      reconcileRepositoryCheckouts(repository.repoId, controllerHome).archivedCheckoutIds);

    // Rebuild from records first so a lost/stale active or request index
    // cannot hide accepted work from reconciliation or idempotency lookup.
    result.executionIndexesRebuilt = run('execution-indexes', () => {
      rebuildExecutionJobIndexes(controllerHome, [repository.repoId]);
      return true;
    });
    result.executionJobs = run('execution-jobs', () => reconcileExecutionJobs(controllerHome, repository.repoId));
    result.localJobs = run('local-jobs', () => reconcileLocalBridgeJobs(repository.canonicalRoot));
    result.activeLeases = run('leases', () => listActiveLeases(controllerHome, repository.repoId).length);
    result.workContracts = run('work-contracts', () => {
      const activeExecutionJobs = listExecutionJobs(controllerHome, repository.repoId, 500)
        .filter((job) => ['queued', 'dispatched', 'running', 'waiting_for_approval'].includes(job.status)).length;
      const activeLocalJobs = listLocalBridgeJobs(repository.canonicalRoot, 500)
        .filter((job) => ['approved', 'dispatched', 'running'].includes(job.status)).length;
      const activeLeases = listActiveLeases(controllerHome, repository.repoId).length;
      return reconcileStaleWorkContracts(
        { controllerHome, repoId: repository.repoId },
        { activeExecutionJobs, activeLocalJobs, activeLeases },
      );
    });
    result.projectionRebuilt = run('projection', () => {
      if (!projectionNeedsRebuild(controllerHome, repository.repoId)) return false;
      rebuildRepositoryProjection(controllerHome, repository.repoId);
      return true;
    });
    recovered.push(result);
  }
  // Controller-scoped plugin work uses the same durable Job and lease stores,
  // but it is intentionally absent from the Repository Registry. Reconcile it
  // explicitly so a daemon restart cannot strand local_system work.
  const controllerResult: ControllerRecoveryRepositoryResult = {
    repoId: CONTROLLER_SCOPE_REPO_ID,
    degraded: false,
  };
  const runController = <T>(phase: ControllerRecoveryError['phase'], action: () => T): T | undefined => {
    try {
      return action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controllerResult.degraded = true;
      errors.push({ repoId: CONTROLLER_SCOPE_REPO_ID, phase, code: errorCode(error), message });
      return undefined;
    }
  };
  controllerResult.executionIndexesRebuilt = runController('execution-indexes', () => {
    rebuildExecutionJobIndexes(controllerHome, [CONTROLLER_SCOPE_REPO_ID]);
    return true;
  });
  controllerResult.executionJobs = runController('execution-jobs', () =>
    reconcileExecutionJobs(controllerHome, CONTROLLER_SCOPE_REPO_ID));
  controllerResult.activeLeases = runController('leases', () =>
    listActiveLeases(controllerHome, CONTROLLER_SCOPE_REPO_ID).length);
  recovered.push(controllerResult);

  return {
    completedAt: new Date().toISOString(),
    repositories: recovered,
    errors,
    degraded: errors.length > 0,
  };
}
