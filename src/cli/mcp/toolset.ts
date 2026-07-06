import type { McpToolDefinition } from './tools';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { buildMultiRepositoryToolDefinitions } from './multi-repository';
import { repositoryToolDefinitions } from './repository-tools';
import { runtimeToolDefinitions } from '../../runtime/gateway/mcp/runtime-tools';

export const CORE_CONTROLLER_TOOL_NAMES = [
  'controller_capabilities',
  'controller_ready',
  'controller_context',
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
  'get_job',
  'get_artifact',
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
