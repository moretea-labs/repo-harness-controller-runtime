import { FACADE_TOOLS } from '../../runtime/control-plane/facade/types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

/** Minimal bootstrap subset retained for diagnostics and constrained clients. */
export const BOOTSTRAP_CONTROLLER_TOOL_NAMES = [
  ...PREFERRED_FACADE_TOOL_NAMES,
  'repository_access_get',
  'repository_list',
  'repository_get',
  'repository_register',
  'repository_latest_source_diagnose',
  'repository_bootstrap_local_project',
] as const;

export const STABLE_CONTROLLER_TOOL_NAMES = [
  ...PREFERRED_FACADE_TOOL_NAMES,

  // Session-aware execution fast path and secure result retrieval.
  'session_start',
  'session_bind_repository',
  'work_prepare',
  'work_inspect',
  'work_execute',
  'work_validate',
  'work_finalize',
  'approval_resolve',
  'result_read',
  'result_search',

  // Controller truth, context, and readiness.
  'controller_capabilities',
  'controller_ready',
  'controller_context',
  'controller_context_pack',
  'local_bridge_status',

  // Access policy and repository selection/bootstrap.
  'repository_access_get',
  'repository_access_set',
  'repository_list',
  'repository_get',
  'repository_register',
  'repository_latest_source_diagnose',
  'repository_bootstrap_local_project',

  // Source inspection and deterministic Direct Edit.
  'search_repository',
  'read_repository_file',
  'get_git_diff',
  'repository_safe_patch_plan',
  'repository_safe_patch_apply',
  'begin_edit_session',
  'apply_patch',
  'get_edit_session',
  'list_edit_sessions',
  'get_edit_session_diff',
  'create_edit_savepoint',
  'verify_edit_session',
  'rollback_edit_session',
  'finalize_edit_session',

  // Commands, checks, and local Git lifecycle.
  'repository_command_preview',
  'repository_command_execute',
  'list_checks',
  'run_check',
  'run_workflow_check',
  'repository_git_status',
  'repository_git_diff',
  'repository_git_create_branch',
  'repository_git_switch_branch',
  'repository_git_merge_branch',
  'repository_git_delete_branch',
  'repository_git_commit',
  'repository_git_finish_workflow',
  'git_diff_paths',
  'git_stage_paths',
  'git_commit_paths',

  // Durable work and evidence.
  'work_submit',
  'work_get',
  'work_list',
  'work_cancel',
  'work_wait',
  'work_result_summary',
  'work_status_digest',
  'get_job',
  'get_artifact',

  // Issue/task execution and direct local agents.
  'list_issues',
  'get_project_board',
  'get_project_progress',
  'get_issue',
  'inspect_issue_readiness',
  'inspect_task_readiness',
  'create_issue',
  'update_issue',
  'plan_issue',
  'append_task',
  'update_task',
  'dispatch_task',
  'quick_agent_session',
  'launch_issue',
  'dispatch_ready_tasks',
  'get_task_run',
  'get_task_run_events',
  'get_task_diff',
  'list_task_runs',
  'finish_task_run',
  'cancel_task_run',
  'retry_task_run',
  'verify_task',
  'accept_task',
  'request_task_changes',

  // Supervised multi-step campaigns.
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

  // Personal-assistant plugins, browser targets, and auth handoffs.
  'list_plugins',
  'get_plugin',
  'plugin_action_execute',
  'toolchain_plugin_summary',
  'workspace_auth_status',
  'workspace_auth_login_prepare',
  'web_targets_list',
  'web_target_snapshot',
  'web_domain_access_preview',
  'web_domain_access_apply',
  'assistant_readiness',

  // iOS/Xcode/simulator and visual evidence.
  'ios_app_launch',
  'ios_simulator_screenshot',
  'ios_simulator_log_tail',
  'ios_ui_smoke_test',

  // Recovery without process restart.
  'capability_recovery_probe',
  'capability_recovery_plan',
  'capability_recovery_apply',
  'runtime_maintenance_status',
  'runtime_maintenance_apply',
  'self_healing_monitor_tick',
  'workflow_watchdog_report',
] as const;

/** The default connector schema is the stable repair-capable surface. */
export const DEFAULT_CONTROLLER_TOOL_NAMES = STABLE_CONTROLLER_TOOL_NAMES;
