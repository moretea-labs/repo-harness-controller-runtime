import type { AssistantPluginManifest } from '../../plugins/types';
import type { CapabilityDescriptor, CapabilityDomain, CapabilityOperationClass, CapabilityRisk, FacadeTool } from './types';

const CORE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    capabilityId: 'repository.direct_edit',
    domain: 'repository',
    operationClass: 'write',
    risk: 'local_repo_write',
    exposedVia: 'rh_work',
    summary: 'Apply bounded direct edits, patches, selected-path staging, selected commits, and targeted checks for small supervised tasks.',
  },
  {
    capabilityId: 'controller.goal_workloop',
    domain: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    summary: 'Run a recoverable multi-step work contract through isolated worktree, worker, approval, verification, and continuation handoff.',
  },
  {
    capabilityId: 'controller.handoff_inbox',
    domain: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_inbox',
    summary: 'Persist pending decisions that need ChatGPT or user judgement without turning normal logs into inbox items.',
  },
  {
    capabilityId: 'controller.status',
    domain: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_status',
    summary: 'Read bounded controller, queue, worker, projection, plugin, and readiness status.',
  },
  {
    capabilityId: 'repository.context',
    domain: 'repository',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_context',
    summary: 'Read bounded repository context, checks, project state, and execution-mode recommendations.',
  },
  {
    capabilityId: 'evidence.read',
    domain: 'evidence',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_context',
    summary: 'Read bounded evidence and artifact references without returning raw logs by default.',
  },
  {
    capabilityId: 'maintenance.safe_repair',
    domain: 'maintenance',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_status',
    summary: 'Run bounded runtime repair and maintenance only after policy gate approval.',
  },
  {
    capabilityId: 'controller.self_healing',
    domain: 'maintenance',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    summary: 'Diagnose and dry-run repair stuck jobs, stale projections, invalid check pollution, and worker unavailability without treating infrastructure failure as acceptance failure.',
  },
  {
    capabilityId: 'controller.codex_delegation',
    domain: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    summary: 'Delegate bounded cerebellum work to Codex/Claude with context packs; outputs evidence, handoff, patch proposal, and suggested actions only — never finalize.',
  },
  {
    capabilityId: 'controller.autonomous_goal_loop',
    domain: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    summary: 'Daemon-owned GoalContract loop with provider registry, executor routing, verification, repair, and ChatGPT handoff packets. Models never bypass policy; ChatGPT is handoff-only.',
  },
  {
    capabilityId: 'controller.work_contract',
    domain: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    summary: 'Persist and advance WorkContract records for goal workloop start/continue/verify/finalize/stop.',
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
    operationClass: operationClassFromAction(action.readOnly, action.risk),
    risk: riskFromAction(action.risk),
    exposedVia: exposedViaFromPluginAction(action.readOnly, action.risk),
    summary: `${manifest.displayName}: ${action.title}. ${action.description}`,
  } satisfies CapabilityDescriptor)));
}

export function listCapabilityDescriptors(manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor[] {
  const byId = new Map<string, CapabilityDescriptor>();
  for (const descriptor of [...CORE_CAPABILITIES, ...pluginCapabilities(manifests)]) byId.set(descriptor.capabilityId, descriptor);
  return [...byId.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}

export function getCapabilityDescriptor(capabilityId: string, manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor | undefined {
  return listCapabilityDescriptors(manifests).find((descriptor) => descriptor.capabilityId === capabilityId);
}
