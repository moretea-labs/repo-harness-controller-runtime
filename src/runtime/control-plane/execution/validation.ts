import { existsSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { getRepository, selectRepositoryCheckout, validateRepository } from '../../../cli/repositories/registry';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { getWorkContract } from '../facade/work-contract-store';
import type { WorkContract } from '../facade/types';
import { requireExecutionSession, type ExecutionSessionContext, type SessionIdentity } from './session-store';
import type { WorkHandleState } from './work-handle-store';

export type ValidationLevel = 'none' | 'cheap' | 'full';

export interface ValidatedWorkHandle {
  session: ExecutionSessionContext;
  repository: RepositoryRecord;
  worktreeRepository: RepositoryRecord;
  contract?: WorkContract;
  handle: WorkHandleState;
  currentHead?: string;
  currentBranch?: string;
  warnings: string[];
}

function gitText(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

export function currentPermissionSnapshotVersion(controllerHome: string, repoId: string): number {
  return readRepositoryAccessPolicy(controllerHome, repoId).revision;
}

export function assertWorkHandleLifecycle(handle: WorkHandleState, operation: 'inspect' | 'execute' | 'validate' | 'finalize'): void {
  const allowed: Record<typeof operation, readonly WorkHandleState['state'][]> = {
    inspect: ['prepared', 'editing', 'validating', 'committed', 'merged'],
    execute: ['prepared', 'editing'],
    validate: ['prepared', 'editing', 'validating', 'committed', 'merged'],
    finalize: ['prepared', 'editing', 'validating', 'committed', 'merged', 'cleaned'],
  };
  if (!allowed[operation].includes(handle.state)) {
    fail('WORK_HANDLE_LIFECYCLE_INVALID', `${operation} is not valid while handle is ${handle.state}`);
  }
}

export function validateWorkHandle(
  controllerHome: string,
  handle: WorkHandleState,
  identity: SessionIdentity,
  level: ValidationLevel,
  operation: 'inspect' | 'execute' | 'validate' | 'finalize',
): ValidatedWorkHandle {
  const session = requireExecutionSession(controllerHome, identity);
  if (handle.sessionId !== session.sessionId) fail('WORK_HANDLE_SESSION_MISMATCH', 'work handle belongs to another session');
  if (handle.principalId !== session.principalId) fail('WORK_HANDLE_PRINCIPAL_MISMATCH', 'work handle belongs to another principal');
  if (session.activeRepositoryId !== handle.repositoryId || session.activeCheckoutId !== handle.checkoutId) {
    fail('WORK_HANDLE_NOT_ACTIVE', 'work handle is not bound to the active session repository/checkout');
  }
  if (session.activeWorkId !== handle.workId) fail('WORK_HANDLE_NOT_ACTIVE', 'work handle is not the active session work');
  assertWorkHandleLifecycle(handle, operation);

  const repository = getRepository(handle.repositoryId, controllerHome, { includeRemoved: true });
  if (repository.removedAt || repository.enabled === false) fail('REPOSITORY_NOT_EXECUTABLE', `repository ${repository.repoId} is disabled or removed`);
  const worktreeRepository = selectRepositoryCheckout(repository, handle.checkoutId);
  if (worktreeRepository.activeCheckoutId !== handle.checkoutId) fail('CHECKOUT_NOT_REGISTERED', handle.checkoutId);

  const permissionVersion = currentPermissionSnapshotVersion(controllerHome, repository.repoId);
  if (permissionVersion !== handle.permissionSnapshotVersion) {
    fail('WORK_HANDLE_STALE_PERMISSION', `permission snapshot ${handle.permissionSnapshotVersion} is stale; current version is ${permissionVersion}`);
  }

  const warnings: string[] = [];
  if (level === 'none') return { session, repository, worktreeRepository, handle, warnings };

  const root = worktreeRepository.canonicalRoot;
  if (!existsSync(root)) fail('WORKTREE_MISSING', `worktree no longer exists: ${root}`);
  const resolvedRoot = realpathSync(root);
  if (resolvedRoot !== realpathSync(handle.worktreePath)) fail('WORKTREE_PATH_MISMATCH', 'registered checkout and work handle path differ');
  const gitRoot = gitText(root, ['rev-parse', '--show-toplevel']);
  if (!gitRoot || realpathSync(gitRoot) !== resolvedRoot) fail('WORKTREE_INVALID', 'worktree is no longer a valid Git checkout');
  const currentBranch = gitText(root, ['branch', '--show-current']);
  const currentHead = gitText(root, ['rev-parse', '--verify', 'HEAD']);
  if (currentBranch !== handle.branch) fail('WORK_HANDLE_BRANCH_CHANGED', `expected ${handle.branch}, found ${currentBranch ?? 'detached'}`);
  if (handle.expectedHead && currentHead !== handle.expectedHead) fail('WORK_HANDLE_HEAD_CHANGED', `expected ${handle.expectedHead}, found ${currentHead ?? 'missing'}`);

  if (level === 'full') {
    const validation = validateRepository(repository.repoId, controllerHome);
    if (handle.checkoutId === repository.activeCheckoutId && !validation.ok) {
      fail('REPOSITORY_VALIDATION_FAILED', validation.errors.join('; ') || 'repository validation failed');
    }
    const contract = handle.workContractId
      ? getWorkContract({ controllerHome, repoId: repository.repoId }, handle.workContractId)
      : undefined;
    if (handle.workContractId && !contract) fail('WORK_CONTRACT_MISSING', handle.workContractId);
    if (contract && contract.repoId !== handle.repositoryId) fail('WORK_CONTRACT_REPOSITORY_MISMATCH', handle.workContractId ?? '');
    return { session, repository, worktreeRepository, contract, handle, currentHead, currentBranch, warnings };
  }
  return { session, repository, worktreeRepository, handle, currentHead, currentBranch, warnings };
}
