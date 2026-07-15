import { ensureControllerHome } from '../../../cli/repositories/controller-home';
import { registerRepository } from '../../../cli/repositories/registry';
import type { LocalBridgeJob } from '../../../cli/local-bridge/types';
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS } from '../../../cli/controller/runtime-config';
import { ensureControllerDaemon } from '../../control-plane/daemon-client';
import { createExecutionJob } from './store';
import type { ResourceClaimSpec } from './types';
import { commandValue, normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';

const LEGACY_SETTLEMENT_GRACE_MS = 30_000;
const MAX_DURABLE_EXECUTION_TIMEOUT_MS = 24 * 60 * 60_000;
/** Parent Agent-delegation Jobs only accept the child Run; keep the parent deadline short. */
const AGENT_DELEGATION_PARENT_TIMEOUT_MS = 120_000;

export function legacySettlementTimeoutMs(job: LocalBridgeJob): number {
  if (job.action === 'launch-task' || job.action === 'quick-agent-session') {
    return AGENT_DELEGATION_PARENT_TIMEOUT_MS;
  }
  const payload = job.payload as { timeoutMs?: unknown };
  const requested = typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs)
    ? Math.max(1_000, Math.min(payload.timeoutMs, MAX_AGENT_TIMEOUT_MS))
    : DEFAULT_AGENT_TIMEOUT_MS;
  return Math.min(requested + LEGACY_SETTLEMENT_GRACE_MS, MAX_DURABLE_EXECUTION_TIMEOUT_MS);
}

function requestId(job: LocalBridgeJob): string {
  const payload = job.payload as { requestId?: string };
  return payload.requestId?.trim() || `legacy-local-job:${job.jobId}`;
}

function claims(job: LocalBridgeJob, repoId: string, checkoutId: string): ResourceClaimSpec[] {
  if (job.action === 'run-check' || job.action === 'verify-edit-session') return [{ resourceKey: `heavy-check:${repoId}`, mode: 'exclusive' }];
  if (job.action === 'repository-command') return [
    { resourceKey: `workspace:${checkoutId}`, mode: 'write' },
    { resourceKey: `git-refs:${repoId}`, mode: 'exclusive' },
  ];
  // Parent only creates/accepts the Agent Run; workspace write ownership belongs to the child Run.
  if (job.action === 'launch-task' || job.action === 'quick-agent-session') {
    return [{ resourceKey: `agent-dispatch:${repoId}:${job.jobId}`, mode: 'write' }];
  }
  return [{ resourceKey: `workspace:${checkoutId}`, mode: 'write' }];
}

export function dispatchLegacyLocalJob(repoRoot: string, legacyJob: LocalBridgeJob) {
  const settlementTimeoutMs = legacySettlementTimeoutMs(legacyJob);
  const controllerHome = ensureControllerHome(
    legacyJob.action === 'repository-command' && 'controllerHome' in legacyJob.payload
      ? String(legacyJob.payload.controllerHome)
      : undefined,
  );
  const repository = registerRepository({ path: repoRoot, controllerHome });
  const agentDelegation = legacyJob.action === 'launch-task' || legacyJob.action === 'quick-agent-session';
  const created = createExecutionJob(controllerHome, {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    type: legacyJob.action === 'run-check'
      ? 'check'
      : legacyJob.action === 'verify-edit-session'
        ? 'verify-edit'
        : legacyJob.action === 'repository-command'
          ? 'repository-command'
          : legacyJob.action === 'quick-agent-session'
            ? 'agent-run'
            : 'dispatch-task',
    requestId: requestId(legacyJob),
    semanticKey: `legacy-local-job:${repository.repoId}:${legacyJob.jobId}`,
    priority: legacyJob.action === 'run-check' || legacyJob.action === 'verify-edit-session' ? 'P0' : 'P1',
    origin: { surface: 'local-ui', actor: legacyJob.requestedBy, causationId: legacyJob.jobId },
    payload: {
      operation: 'legacy-local-job',
      target: 'runtime',
      arguments: {
        localJobId: legacyJob.jobId,
        ...(legacyJob.action === 'repository-command'
          ? { command: commandValue(normalizeRepositoryCommand((legacyJob.payload as { command: string | string[] }).command)) }
          : {}),
        ...(agentDelegation ? { agentDelegation: true, localAction: legacyJob.action } : {}),
      },
      timeoutMs: settlementTimeoutMs,
    },
    resourceClaims: claims(legacyJob, repository.repoId, repository.activeCheckoutId),
    timeoutMs: settlementTimeoutMs,
    maxAttempts: agentDelegation ? 3 : 2,
  });
  const daemon = ensureControllerDaemon(controllerHome);
  return { controllerHome, repository, executionJob: created.job, deduplicated: created.deduplicated, daemon };
}
