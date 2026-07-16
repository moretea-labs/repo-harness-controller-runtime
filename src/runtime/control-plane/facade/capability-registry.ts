import type { AssistantPluginManifest } from '../../plugins/types';
import type { CapabilityDescriptor, CapabilityDomain, CapabilityGroupSummary, CapabilityOperationClass, CapabilityRisk, FacadeTool } from './types';

const CORE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    capabilityId: 'repository.direct_edit',
    domain: 'repository',
    group: 'repository-core',
    operationClass: 'write',
    risk: 'local_repo_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Apply bounded direct edits, patches, selected-path staging, selected commits, and targeted checks for small supervised tasks.',
  },
  {
    capabilityId: 'controller.goal_workloop',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Run a recoverable multi-step work contract through isolated worktree, worker, approval, verification, and continuation handoff.',
  },
  {
    capabilityId: 'controller.handoff_inbox',
    domain: 'controller',
    group: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_inbox',
    schemaExposure: 'stable_static',
    summary: 'Persist pending decisions that need ChatGPT or user judgement without turning normal logs into inbox items.',
  },
  {
    capabilityId: 'controller.status',
    domain: 'controller',
    group: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_status',
    schemaExposure: 'stable_static',
    summary: 'Read bounded controller, queue, worker, projection, plugin, and readiness status.',
  },
  {
    capabilityId: 'controller.stable_supervisor',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Inspect and request bounded Supervisor-owned runtime restart, rollout, rollback, and recovery operations with durable reconnect-safe identifiers.',
  },
  {
    capabilityId: 'repository.context',
    domain: 'repository',
    group: 'repository-core',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_context',
    schemaExposure: 'stable_static',
    summary: 'Read bounded repository context, checks, project state, and execution-mode recommendations.',
  },
  {
    capabilityId: 'evidence.read',
    domain: 'evidence',
    group: 'evidence',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_context',
    schemaExposure: 'stable_static',
    summary: 'Read bounded evidence and artifact references without returning raw logs by default.',
  },
  {
    capabilityId: 'maintenance.safe_repair',
    domain: 'maintenance',
    group: 'runtime-maintenance',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_status',
    schemaExposure: 'stable_static',
    summary: 'Run bounded runtime repair and maintenance only after policy gate approval.',
  },
  {
    capabilityId: 'controller.self_healing',
    domain: 'maintenance',
    group: 'runtime-maintenance',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Diagnose and dry-run repair stuck jobs, stale projections, invalid check pollution, and worker unavailability without treating infrastructure failure as acceptance failure.',
  },
  {
    capabilityId: 'controller.codex_delegation',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Delegate bounded implementation work to Codex or Claude with context packs; workers return evidence and proposals but do not own final acceptance.',
  },
  {
    capabilityId: 'controller.autonomous_goal_loop',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Advance daemon-owned goal contracts through deterministic policy, executor routing, verification, repair, and handoff.',
  },
  {
    capabilityId: 'controller.work_contract',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Persist and advance WorkContract records for goal workloop start, continue, verify, finalize, and stop.',
  },
  {
    capabilityId: 'repository.git',
    domain: 'repository',
    group: 'git',
    operationClass: 'finalize',
    risk: 'local_repo_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Use typed Git status, diff, branch, commit, integration, and cleanup handlers without routing arbitrary Git text through a facade RPC.',
  },
  {
    capabilityId: 'workflow.issue_task',
    domain: 'controller',
    group: 'issue-task',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Plan, dispatch, review, verify, retry, and accept durable Issue and Task work through existing typed handlers.',
  },
  {
    capabilityId: 'workflow.campaign',
    domain: 'controller',
    group: 'campaign',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Coordinate multi-step campaign DAGs and review checkpoints while keeping integration and final acceptance explicit.',
  },
  {
    capabilityId: 'plugin.browser',
    domain: 'plugin',
    group: 'browser',
    operationClass: 'execute',
    risk: 'unknown',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Use typed browser target, snapshot, domain grant, and plugin actions when browser capability is configured.',
  },
  {
    capabilityId: 'platform.ios',
    domain: 'plugin',
    group: 'ios',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Use typed Xcode, simulator launch, screenshot, log, and smoke-test handlers when the local iOS toolchain is ready.',
  },
];

function riskFromAction(actionRisk: string): CapabilityRisk {
  if (actionRisk === 'readonly') return 'readonly';
  if (actionRisk === 'remote_write') return 'remote_write';
  if (actionRisk === 'destructive') return 'destructive_remote';
  if (actionRisk === 'workspace_write') return 'workspace_write';
  return 'unknown';
}

function operationClassFromAction(readOnly: boolean, risk: string): CapabilityOperationClass {
  if (readOnly || risk === 'readonly') return 'read';
  if (risk === 'destructive') return 'finalize';
  if (risk === 'remote_write') return 'execute';
  return 'write';
}

function domainFromPlugin(pluginId: string): CapabilityDomain {
  if (pluginId === 'github') return 'repository';
  if (pluginId === 'browser') return 'plugin';
  return 'plugin';
}

function exposedViaFromPluginAction(readOnly: boolean, risk: string): FacadeTool {
  if (readOnly || risk === 'readonly') return 'rh_context';
  return 'rh_work';
}

export function pluginCapabilities(manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor[] {
  return manifests.flatMap((manifest) => manifest.actions.map((action) => ({
    capabilityId: `plugin.${manifest.pluginId}.${action.actionId}`,
    domain: domainFromPlugin(manifest.pluginId),
    group: manifest.pluginId === 'browser' ? 'browser' : 'plugin',
    operationClass: operationClassFromAction(action.readOnly, action.risk),
    risk: riskFromAction(action.risk),
    exposedVia: exposedViaFromPluginAction(action.readOnly, action.risk),
    schemaExposure: 'plugin_manifest',
    summary: `${manifest.displayName}: ${action.title}. ${action.description}`,
  } satisfies CapabilityDescriptor)));
}

export function listCapabilityDescriptors(manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor[] {
  const byId = new Map<string, CapabilityDescriptor>();
  for (const descriptor of [...CORE_CAPABILITIES, ...pluginCapabilities(manifests)]) byId.set(descriptor.capabilityId, descriptor);
  return [...byId.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}

export function summarizeCapabilityGroups(manifests: readonly AssistantPluginManifest[] = []): CapabilityGroupSummary[] {
  const grouped = new Map<CapabilityDescriptor['group'], CapabilityDescriptor[]>();
  for (const descriptor of listCapabilityDescriptors(manifests)) {
    const entries = grouped.get(descriptor.group) ?? [];
    entries.push(descriptor);
    grouped.set(descriptor.group, entries);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, entries]) => ({
      group,
      capabilityCount: entries.length,
      domains: [...new Set(entries.map((entry) => entry.domain))].sort(),
      facadeTools: [...new Set(entries.map((entry) => entry.exposedVia))].sort(),
      operationClasses: [...new Set(entries.map((entry) => entry.operationClass))].sort(),
      risks: [...new Set(entries.map((entry) => entry.risk))].sort(),
      schemaExposures: [...new Set(entries.map((entry) => entry.schemaExposure))].sort(),
    }));
}

export function getCapabilityDescriptor(capabilityId: string, manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor | undefined {
  return listCapabilityDescriptors(manifests).find((descriptor) => descriptor.capabilityId === capabilityId);
}
