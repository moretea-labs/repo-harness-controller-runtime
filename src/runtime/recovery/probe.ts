import { RECOVERY_ACTIONS } from './actions';
import { classifyFailure, dominantRecoveryClass } from './classifier';
import type {
  CapabilityRecoveryInput,
  CapabilityRecoverySnapshot,
  CapabilityState,
  CapabilityStatus,
  RecoveryActionDescriptor,
  RecoveryClass,
  RecoveryEvidence,
} from './types';

const SCHEDULER_STALE_MS = 10_000;
const CONTEXT_PROJECTION_STALE_MS = 30_000;

function evidence(source: string, message: string, at: string, details?: Record<string, unknown>): RecoveryEvidence[] {
  return [{ source, message, at, details }];
}

function capability(
  at: string,
  id: string,
  label: string,
  state: CapabilityState,
  recoveryClass: RecoveryClass,
  reason: string,
  suggestedActions: RecoveryActionDescriptor[] = [],
  details?: Record<string, unknown>,
): CapabilityStatus {
  return { id, label, state, class: recoveryClass, reason, suggestedActions, evidence: evidence(id, reason, at, details) };
}

function dedupeActions(actions: RecoveryActionDescriptor[]): RecoveryActionDescriptor[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
}

function countStates(capabilities: CapabilityStatus[]): Record<CapabilityState, number> {
  return capabilities.reduce<Record<CapabilityState, number>>((counts, item) => {
    counts[item.state] += 1;
    return counts;
  }, { ready: 0, degraded: 0, blocked: 0, unavailable: 0, unknown: 0 });
}

function classifyRecentErrors(input: CapabilityRecoveryInput): RecoveryClass {
  return dominantRecoveryClass((input.recentErrors ?? []).map(classifyFailure));
}

function failingJobClass(input: CapabilityRecoveryInput): RecoveryClass {
  const messages = [
    ...(input.localJobs ?? []).flatMap((job) => job.error ? [job.error] : []),
    ...(input.executionJobs ?? []).flatMap((job) => job.error ? [typeof job.error === 'string' ? job.error : JSON.stringify(job.error)] : []),
  ];
  return dominantRecoveryClass(messages.map(classifyFailure));
}

function runtimeStorageClass(input: CapabilityRecoveryInput): RecoveryClass {
  return dominantRecoveryClass((input.runtimeStorageWarnings ?? []).map(classifyFailure));
}

function runtimeStorageActions(recoveryClass: RecoveryClass): RecoveryActionDescriptor[] {
  if (recoveryClass === 'local_jobs_unreadable') return [RECOVERY_ACTIONS.quarantineUnreadableLocalJobs, RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
  if (recoveryClass === 'local_jobs_legacy_active') return [RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
  if (recoveryClass === 'runtime_storage_not_ready') return [RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
  return [RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
}

function commandExecuteActions(recoveryClass: RecoveryClass): RecoveryActionDescriptor[] {
  if (recoveryClass === 'platform_blocked') return [RECOVERY_ACTIONS.createPatchHandoff];
  if (['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable', 'local_jobs_reconciliation_required'].includes(recoveryClass)) {
    return runtimeStorageActions(recoveryClass);
  }
  return [RECOVERY_ACTIONS.probeAgain];
}

export function buildCapabilityRecoverySnapshot(input: CapabilityRecoveryInput): CapabilityRecoverySnapshot {
  const at = input.generatedAt ?? new Date().toISOString();
  const capabilities: CapabilityStatus[] = [];
  const daemonReady = input.daemonStatus === undefined || input.daemonStatus === 'ready';
  capabilities.push(daemonReady
    ? capability(at, 'controller.daemon', 'Controller daemon', 'ready', 'unknown', 'Controller daemon is ready.', [], { status: input.daemonStatus ?? 'unknown' })
    : capability(at, 'controller.daemon', 'Controller daemon', 'unavailable', 'local_recoverable', `Controller daemon is ${input.daemonStatus ?? 'unknown'}.`, [RECOVERY_ACTIONS.restartController], { status: input.daemonStatus, error: input.daemonError }));

  const schedulerAge = input.schedulerHeartbeatAgeMs;
  const schedulerStale = typeof schedulerAge === 'number' && schedulerAge > SCHEDULER_STALE_MS;
  capabilities.push(schedulerStale || input.schedulerStatus === 'degraded' || input.schedulerStatus === 'not_ready'
    ? capability(at, 'durable.scheduler', 'Durable scheduler', 'degraded', 'stale_runtime_state', 'Scheduler heartbeat is stale or degraded.', [RECOVERY_ACTIONS.reconcileJobs, RECOVERY_ACTIONS.restartController], { schedulerStatus: input.schedulerStatus, schedulerHeartbeatAgeMs: schedulerAge })
    : capability(at, 'durable.scheduler', 'Durable scheduler', 'ready', 'unknown', 'Scheduler heartbeat is healthy.', [], { schedulerStatus: input.schedulerStatus, schedulerHeartbeatAgeMs: schedulerAge }));

  const queueDepth = input.queueDepth ?? 0;
  const runningWorkers = input.runningWorkers ?? 0;
  const activeLeases = input.activeLeases ?? 0;
  const queueStalled = queueDepth > 0 && runningWorkers === 0;
  capabilities.push(queueStalled || activeLeases > 0 && runningWorkers === 0
    ? capability(at, 'worker.loop', 'Worker loop', 'degraded', 'stale_runtime_state', 'Queued work or leases may be stuck without active workers.', [RECOVERY_ACTIONS.reconcileJobs], { queueDepth, runningWorkers, activeLeases })
    : capability(at, 'worker.loop', 'Worker loop', 'ready', 'unknown', 'Worker loop has no stuck queue evidence.', [], { queueDepth, runningWorkers, activeLeases }));

  capabilities.push(input.localBridgeRunning === false
    ? capability(at, 'local.bridge', 'Local bridge', 'unavailable', 'local_recoverable', 'Local bridge is not running.', [RECOVERY_ACTIONS.restartLocalBridge], { error: input.localBridgeError })
    : capability(at, 'local.bridge', 'Local bridge', 'ready', 'unknown', 'Local bridge is available.', [], { running: input.localBridgeRunning }));

  capabilities.push(input.connectorHealthy === false
    ? capability(at, 'chatgpt.connector', 'ChatGPT connector', 'degraded', 'local_recoverable', 'Connector runtime state does not match the expected tool surface.', [RECOVERY_ACTIONS.restartLocalBridge], { mismatch: input.connectorMismatch })
    : capability(at, 'chatgpt.connector', 'ChatGPT connector', 'ready', 'unknown', 'Connector runtime state matches expected configuration.', [], { healthy: input.connectorHealthy }));

  capabilities.push(input.runtimeProjectionStale === true || input.runtimeProjectionPersisted === false
    ? capability(at, 'runtime.projection', 'Runtime projection', 'degraded', 'stale_runtime_state', 'Runtime projection is stale or missing from persisted state.', [RECOVERY_ACTIONS.rebuildProjection], { stale: input.runtimeProjectionStale, persisted: input.runtimeProjectionPersisted })
    : capability(at, 'runtime.projection', 'Runtime projection', 'ready', 'unknown', 'Runtime projection is available.', [], { stale: input.runtimeProjectionStale, persisted: input.runtimeProjectionPersisted }));

  capabilities.push(input.contextProjectionStale === true
    ? capability(at, 'context.projection', 'Context projection', 'degraded', 'stale_runtime_state', 'Controller context projection is stale.', [RECOVERY_ACTIONS.rebuildProjection], { stale: true, staleThresholdMs: CONTEXT_PROJECTION_STALE_MS })
    : capability(at, 'context.projection', 'Context projection', 'ready', 'unknown', 'Controller context projection is fresh enough.', [], { stale: input.contextProjectionStale }));

  const storageClass = runtimeStorageClass(input);
  if (input.runtimeStorageReady === false || (input.runtimeStorageWarnings ?? []).length > 0) {
    const classifiedStorage = storageClass === 'unknown' ? 'runtime_storage_not_ready' : storageClass;
    capabilities.push(capability(
      at,
      'runtime.storage',
      'Runtime storage',
      'blocked',
      classifiedStorage,
      'Runtime storage is not ready; ordinary execution may be unable to create or dispatch Local Jobs.',
      runtimeStorageActions(classifiedStorage),
      { ready: input.runtimeStorageReady, warnings: input.runtimeStorageWarnings ?? [] },
    ));
  }

  capabilities.push(input.commandPreviewAvailable === false
    ? capability(at, 'tool.command_preview', 'Command preview', 'blocked', 'policy_denied', 'Command preview is blocked or unavailable.', [RECOVERY_ACTIONS.probeAgain])
    : capability(at, 'tool.command_preview', 'Command preview', 'ready', 'unknown', 'Command preview is available.'));

  const recentClass = classifyRecentErrors(input);
  capabilities.push(input.commandExecuteAvailable === false
    ? capability(
      at,
      'tool.command_execute',
      'Command execute',
      'blocked',
      recentClass === 'platform_blocked' ? 'platform_blocked' : recentClass === 'unknown' ? 'policy_denied' : recentClass,
      recentClass === 'platform_blocked'
        ? 'Command execute appears blocked before reaching repo-harness. Do not restart-loop local services.'
        : ['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable', 'local_jobs_reconciliation_required'].includes(recentClass)
          ? 'Command execute is blocked by repo-harness runtime storage; use the maintenance executor instead of repository_command_execute.'
          : 'Command execute is blocked, denied, or unavailable.',
      commandExecuteActions(recentClass),
    )
    : capability(at, 'tool.command_execute', 'Command execute', 'ready', 'unknown', 'Command execute is available.'));

  capabilities.push(input.issueToolsAvailable === false
    ? capability(at, 'tool.issue', 'Issue tools', 'blocked', recentClass, 'Issue tooling is blocked or unavailable.', recentClass === 'platform_blocked' ? [RECOVERY_ACTIONS.createPatchHandoff] : [RECOVERY_ACTIONS.probeAgain])
    : capability(at, 'tool.issue', 'Issue tools', 'ready', 'unknown', 'Issue tooling is available.'));

  capabilities.push(input.jobToolsAvailable === false
    ? capability(at, 'tool.jobs', 'Job tools', 'blocked', recentClass, 'Job tooling is blocked or unavailable.', recentClass === 'platform_blocked' ? [RECOVERY_ACTIONS.createPatchHandoff] : [RECOVERY_ACTIONS.probeAgain])
    : capability(at, 'tool.jobs', 'Job tools', 'ready', 'unknown', 'Job tooling is available.'));

  const jobClass = failingJobClass(input);
  if (jobClass !== 'unknown') {
    capabilities.push(capability(at, 'recent.failures', 'Recent failures', 'degraded', jobClass, `Recent job failures classify as ${jobClass}.`, jobClass === 'agent_runtime_failure' ? [RECOVERY_ACTIONS.reconcileJobs] : ['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable'].includes(jobClass) ? runtimeStorageActions(jobClass) : jobClass === 'source_defect_suspected' ? [RECOVERY_ACTIONS.createSelfFixTask] : [], { localJobs: input.localJobs?.length ?? 0, executionJobs: input.executionJobs?.length ?? 0 }));
  }

  for (const plugin of input.pluginStates ?? []) {
    const state = plugin.healthState ?? (plugin.ready ? 'ready' : plugin.enabled ? 'degraded' : 'disabled');
    if (plugin.enabled === false) {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'degraded', 'user_action_required', 'Plugin is disabled.', [], { state }));
    } else if (plugin.ready === true || state === 'ready') {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'ready', 'unknown', 'Plugin is ready.', [], { state }));
    } else if ((plugin.errors ?? []).some((error) => classifyFailure(error) === 'auth_required')) {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'degraded', 'auth_required', 'Plugin requires authorization or token refresh.', [], { state, errors: plugin.errors }));
    } else {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'degraded', 'plugin_configuration_error', 'Plugin is enabled but not healthy.', [], { state, errors: plugin.errors, warnings: plugin.warnings }));
    }
  }

  if ((input.dirtyPaths ?? []).length > 0) {
    capabilities.push(capability(at, 'worktree.dirty_paths', 'Dirty path conflict guard', 'degraded', 'dirty_worktree_conflict', 'Main worktree has dirty paths. Integration must not overwrite them.', [], { dirtyPaths: input.dirtyPaths }));
  }

  capabilities.push(capability(at, 'assistant.monitor', 'Assistant monitor', 'ready', 'unknown', 'Assistant monitor data is available for the local GUI.', [], input.assistant));

  const states = countStates(capabilities);
  const recommendedActions = dedupeActions(capabilities.flatMap((item) => item.suggestedActions));
  const classes = capabilities.map((item) => item.class);
  const platformBlocked = classes.includes('platform_blocked');
  const topRisks = [...new Set(classes.filter((item) => item !== 'unknown'))].slice(0, 5);
  const overallState: CapabilityState = states.blocked > 0
    ? 'blocked'
    : states.unavailable > 0
      ? 'unavailable'
      : states.degraded > 0
        ? 'degraded'
        : 'ready';

  return {
    schemaVersion: 1,
    generatedAt: at,
    overallState,
    fallbackRequired: platformBlocked,
    platformBlocked,
    capabilities,
    recommendedActions,
    summary: {
      ready: states.ready,
      degraded: states.degraded,
      blocked: states.blocked,
      unavailable: states.unavailable,
      unknown: states.unknown,
      topRisks,
      nextBestAction: recommendedActions[0],
    },
    notes: platformBlocked
      ? ['One or more calls appear blocked before reaching repo-harness. Avoid local restart loops; use patch handoff or narrower typed tools.']
      : (input.runtimeStorageReady === false ? ['Runtime storage is not ready. Use runtime_maintenance_status/runtime_maintenance_apply; do not try to repair repository_command_execute with repository_command_execute.'] : []),
  };
}
