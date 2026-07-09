import type { McpToolDefinition } from './tools';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { buildMultiRepositoryToolDefinitions } from './multi-repository';
import { repositoryToolDefinitions } from './repository-tools';
import { runtimeToolDefinitions } from '../../runtime/gateway/mcp/runtime-tools';
import { FACADE_TOOLS } from '../../runtime/control-plane/facade/types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

export type ToolExposureClass = 'facade' | 'advanced' | 'internal' | 'compatibility';

export const CORE_CONTROLLER_TOOL_NAMES = [
  // Preferred ChatGPT facade (stage-2 control plane)
  'rh_status',
  'rh_inbox',
  'rh_context',
  'rh_work',
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
  'repository_get',
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

export function classifyControllerToolExposure(toolName: string): ToolExposureClass {
  if ((PREFERRED_FACADE_TOOL_NAMES as readonly string[]).includes(toolName)) return 'facade';
  if ((CORE_CONTROLLER_TOOL_NAMES as readonly string[]).includes(toolName)) return 'advanced';
  if (toolName.startsWith('rh_')) return 'facade';
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

const CORE_CONTROLLER_TOOL_SET = new Set<string>(CORE_CONTROLLER_TOOL_NAMES);

export function allControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  return runtimeToolDefinitions.concat(repositoryToolDefinitions, buildMultiRepositoryToolDefinitions(ctx));
}

export function exposedControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  const definitions = allControllerToolDefinitions(ctx);
  return ctx.toolset === 'core'
    ? definitions.filter((tool) => CORE_CONTROLLER_TOOL_SET.has(tool.name))
    : definitions;
}

export function isControllerToolExposed(ctx: MultiRepositoryMcpToolContext, name: string): boolean {
  if (ctx.toolset === 'full') return true;
  return CORE_CONTROLLER_TOOL_SET.has(name);
}
