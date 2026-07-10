import type { McpToolDefinition } from './tools';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { buildMultiRepositoryToolDefinitions } from './multi-repository';
import { repositoryToolDefinitions } from './repository-tools';
import { runtimeToolDefinitions } from '../../runtime/gateway/mcp/runtime-tools';
import { FACADE_TOOLS } from '../../runtime/control-plane/facade/types';
import type { McpToolset } from './types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

export type ToolExposureClass = 'facade' | 'advanced' | 'internal' | 'compatibility';

/**
 * Default tools/list for controller profile (`--toolset core`).
 * Facade entrypoints plus only indispensable repository bootstrap/selection tools.
 */
export const DEFAULT_CONTROLLER_TOOL_NAMES = [
  'rh_status',
  'rh_inbox',
  'rh_context',
  'rh_work',
  'repository_list',
  'repository_get',
  'repository_register',
  'repository_latest_source_diagnose',
  'repository_bootstrap_local_project',
] as const;

/**
 * Explicit advanced/supervised controller surface (`--toolset advanced`).
 * Includes the default set plus recovery, work, campaign, and interactive git tools.
 * This is the former large "core" exposure.
 */
export const ADVANCED_CONTROLLER_TOOL_NAMES = [
  ...DEFAULT_CONTROLLER_TOOL_NAMES,
  // Core controller entrypoints
  'controller_capabilities',
  'controller_ready',
  'controller_context',
  'controller_context_pack',
  'capability_recovery_probe',
  'capability_recovery_plan',
  'capability_recovery_apply',
  'runtime_maintenance_status',
  'runtime_maintenance_apply',
  'self_healing_loop_plan',
  'self_healing_monitor_tick',
  'workspace_auth_status',
  'workspace_auth_login_prepare',
  'external_filesystem_targets_list',
  'external_filesystem_grant_preview',
  'external_filesystem_grant_apply',
  'external_filesystem_text_snapshot',
  'local_bridge_status',
  'list_plugins',
  'get_plugin',
  'plugin_action_execute',
  'toolchain_plugin_summary',
  'web_targets_list',
  'web_target_snapshot',
  'web_domain_access_preview',
  'web_domain_access_apply',
  'work_result_summary',
  'finish_task_run',
  'work_status_digest',
  'model_clients_summary',
  'model_control_plane_summary',
  'deepseek_tool_manifest',
  'deepseek_tool_call_prepare',
  'deepseek_controller_manifest',
  'deepseek_controller_handoff_prepare',
  'deepseek_controller_request_prepare',
  'work_submit',
  'work_get',
  'work_list',
  'work_cancel',
  'work_wait',
  'get_job',
  'get_artifact',
  // Interactive development tools (sync by default)
  'repository_safe_patch_plan',
  'repository_safe_patch_apply',
  'repository_git_status',
  'repository_git_diff',
  'repository_git_create_branch',
  'repository_git_switch_branch',
  'repository_git_commit',
  'git_diff_paths',
  'git_stage_paths',
  'git_commit_paths',
  'create_campaign',
  'list_campaigns',
  'get_campaign',
  'add_campaign_task',
  'pause_campaign',
  'resume_campaign',
  'cancel_campaign',
  'get_campaign_review_packet',
  'submit_campaign_review',
  'accept_campaign',
  'reconcile_campaign',
  'harness_doctor',
] as const;

/**
 * Alias for the default (`core`) exposure set.
 * Prefer DEFAULT_CONTROLLER_TOOL_NAMES in new code.
 */
export const CORE_CONTROLLER_TOOL_NAMES = DEFAULT_CONTROLLER_TOOL_NAMES;

const DEFAULT_CONTROLLER_TOOL_SET = new Set<string>(DEFAULT_CONTROLLER_TOOL_NAMES);
const ADVANCED_CONTROLLER_TOOL_SET = new Set<string>(ADVANCED_CONTROLLER_TOOL_NAMES);

export function normalizeMcpToolset(value: unknown): McpToolset {
  if (value === 'full' || value === 'advanced' || value === 'core') return value;
  return 'core';
}

export function controllerToolNamesForToolset(toolset: McpToolset): readonly string[] | null {
  if (toolset === 'full') return null;
  if (toolset === 'advanced') return ADVANCED_CONTROLLER_TOOL_NAMES;
  return DEFAULT_CONTROLLER_TOOL_NAMES;
}

export function classifyControllerToolExposure(toolName: string): ToolExposureClass {
  if ((PREFERRED_FACADE_TOOL_NAMES as readonly string[]).includes(toolName)) return 'facade';
  if (toolName.startsWith('rh_')) return 'facade';
  if (DEFAULT_CONTROLLER_TOOL_SET.has(toolName)) return 'advanced';
  if (ADVANCED_CONTROLLER_TOOL_SET.has(toolName)) return 'advanced';
  return 'compatibility';
}

export function controllerToolExposureMetadata(toolNames: readonly string[]): {
  preferredTools: string[];
  advancedTools: string[];
  compatibilityTools: string[];
  classification: Record<string, ToolExposureClass>;
} {
  const classification: Record<string, ToolExposureClass> = {};
  for (const name of toolNames) classification[name] = classifyControllerToolExposure(name);
  return {
    preferredTools: toolNames.filter((name) => classification[name] === 'facade'),
    advancedTools: toolNames.filter((name) => classification[name] === 'advanced'),
    compatibilityTools: toolNames.filter((name) => classification[name] === 'compatibility'),
    classification,
  };
}

export function allControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  return runtimeToolDefinitions.concat(repositoryToolDefinitions, buildMultiRepositoryToolDefinitions(ctx));
}

export function exposedControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  const definitions = allControllerToolDefinitions(ctx);
  const allowed = controllerToolNamesForToolset(ctx.toolset);
  if (allowed === null) return definitions;
  const allowedSet = new Set<string>(allowed);
  return definitions.filter((tool) => allowedSet.has(tool.name));
}

export function isControllerToolExposed(ctx: MultiRepositoryMcpToolContext, name: string): boolean {
  if (ctx.toolset === 'full') return true;
  if (ctx.toolset === 'advanced') return ADVANCED_CONTROLLER_TOOL_SET.has(name);
  return DEFAULT_CONTROLLER_TOOL_SET.has(name);
}
