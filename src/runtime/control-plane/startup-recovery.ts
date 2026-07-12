import { listRepositories } from '../../cli/repositories/registry';
import { reconcileLocalBridgeJobs } from '../../cli/local-bridge/job-store';
import { rebuildExecutionJobIndexes } from '../execution/jobs/store';
import { reconcileExecutionJobs } from './global-scheduler/reconciliation';
import { listActiveLeases } from '../resources/leases/store';
import { rebuildRepositoryProjection } from '../projections/materialized-view';

export interface ControllerRecoveryError {
  repoId: string;
  phase: 'execution-indexes' | 'execution-jobs' | 'local-jobs' | 'leases' | 'projection';
  code: string;
  message: string;
}

export interface ControllerRecoveryRepositoryResult {
  repoId: string;
  degraded: boolean;
  executionIndexesRebuilt?: boolean;
  executionJobs?: ReturnType<typeof reconcileExecutionJobs>;
  localJobs?: ReturnType<typeof reconcileLocalBridgeJobs>;
  activeLeases?: number;
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

    // Rebuild from records first so a lost/stale active or request index
    // cannot hide accepted work from reconciliation or idempotency lookup.
    result.executionIndexesRebuilt = run('execution-indexes', () => {
      rebuildExecutionJobIndexes(controllerHome, [repository.repoId]);
      return true;
    });
    result.executionJobs = run('execution-jobs', () => reconcileExecutionJobs(controllerHome, repository.repoId));
    result.localJobs = run('local-jobs', () => reconcileLocalBridgeJobs(repository.canonicalRoot));
    result.activeLeases = run('leases', () => listActiveLeases(controllerHome, repository.repoId).length);
    result.projectionRebuilt = run('projection', () => {
      rebuildRepositoryProjection(controllerHome, repository.repoId);
      return true;
    });
    recovered.push(result);
  }
  return {
    completedAt: new Date().toISOString(),
    repositories: recovered,
    errors,
    degraded: errors.length > 0,
  };
}
