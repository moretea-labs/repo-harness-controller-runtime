import type { ResourceClaimSpec } from '../../execution/jobs/types';

const READ_ONLY_TOOLS = new Set([
  'controller_capabilities',
  'controller_ready',
  'controller_context',
  'project_snapshot',
  'get_project_state',
  'get_project_governance',
  'get_project_progress',
  'get_project_board',
  'get_task_progress_detail',
  'get_issue',
  'list_issues',
  'list_task_runs',
  'list_edit_sessions',
  'list_checks',
  'search_repository',
  'read_repository_file',
  'github_status',
  'repository_get',
  'repository_list',
  'repository_workbench',
  'repository_runtime_snapshot',
  'list_schedules',
  'repository_command_preview',
  'get_local_job',
  'get_local_job_output',
  'local_bridge_status',
  'get_task_run',
  'get_task_run_events',
  'get_task_run_log',
  'get_task_diff',
  'get_worklog_timeline',
  'list_campaigns',
  'get_campaign',
  'get_campaign_review_packet',
]);
const REPO_STATE_TOOLS = new Set([
  'create_issue', 'update_issue', 'plan_issue', 'append_task', 'split_task', 'supersede_task',
  'set_task_dependencies', 'update_task', 'record_task_verification', 'accept_verified_task',
  'write_prd', 'write_prd_from_idea', 'write_sprint', 'write_checklist_sprint', 'write_plan',
  'record_candidate_finding', 'repository_register', 'repository_refresh', 'repository_validate',
  'repository_update', 'repository_disable', 'repository_remove', 'create_edit_savepoint',
  'begin_edit_session', 'set_current_issue', 'archive_issue', 'restore_issue', 'reconcile_project_governance',
  'create_campaign', 'add_campaign_task', 'pause_campaign', 'resume_campaign', 'cancel_campaign',
  'submit_campaign_review', 'accept_campaign', 'reconcile_campaign',
]);
const CHECK_TOOLS = new Set(['run_check', 'verify_edit_session']);
const INTEGRATION_TOOLS = new Set(['integrate_task_run']);
const REMOTE_TOOLS = new Set(['publish_issue_to_github', 'refresh_github_issue', 'close_github_issue', 'configure_github_plugin']);
const AGENT_TOOLS = new Set(['dispatch_task', 'launch_issue', 'dispatch_ready_tasks', 'retry_task_run', 'quick_agent_session']);
const WORKSPACE_WRITE_TOOLS = new Set([
  'apply_patch', 'apply_edit_operations', 'rollback_edit_session', 'finalize_edit_session',
  'repository_command_execute',
]);

function operationPaths(args: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const allowed = args.allowed_paths;
  if (Array.isArray(allowed)) for (const value of allowed) if (typeof value === 'string' && value.trim()) paths.add(value.trim());
  const operations = args.operations;
  if (Array.isArray(operations)) {
    for (const operation of operations) {
      if (operation && typeof operation === 'object') {
        const path = (operation as Record<string, unknown>).path;
        if (typeof path === 'string' && path.trim()) paths.add(path.trim());
      }
    }
  }
  const path = args.path;
  if (typeof path === 'string' && path.trim()) paths.add(path.trim());
  return [...paths];
}

function isolatedWorktreeKey(args: Record<string, unknown>): string {
  const issueId = typeof args.issue_id === 'string' ? args.issue_id.trim() : '';
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  const identity = (issueId && taskId ? `${issueId}-${taskId}` : runId || taskId || issueId || requestId || 'isolated')
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  return identity || 'isolated';
}

export function claimsForMcpOperation(name: string, args: Record<string, unknown>, repoId: string, checkoutId?: string): ResourceClaimSpec[] {
  if (READ_ONLY_TOOLS.has(name)) return [];
  if (name === 'create_campaign') return [
    { resourceKey: 'repo-state', mode: 'write' },
    { resourceKey: `git-refs:${repoId}`, mode: 'exclusive' },
  ];
  if (REPO_STATE_TOOLS.has(name)) return [{ resourceKey: 'repo-state', mode: 'write' }];
  if (CHECK_TOOLS.has(name)) return [{ resourceKey: `heavy-check:${repoId}`, mode: 'exclusive' }];
  if (INTEGRATION_TOOLS.has(name)) return [
    { resourceKey: `integration:${repoId}`, mode: 'exclusive' },
    { resourceKey: `workspace:${checkoutId ?? 'active'}`, mode: 'write' },
    { resourceKey: `git-refs:${repoId}`, mode: 'exclusive' },
  ];
  if (REMOTE_TOOLS.has(name)) return [{ resourceKey: `remote:${repoId}`, mode: 'exclusive' }];
  if (AGENT_TOOLS.has(name)) {
    if (args.agent === 'github-copilot') return [{ resourceKey: `remote:${repoId}`, mode: 'exclusive' }];
    if (args.isolate === true) return [{ resourceKey: `worktree:${isolatedWorktreeKey(args)}`, mode: 'write' }];
    return [{ resourceKey: `workspace:${checkoutId ?? 'active'}`, mode: 'write' }];
  }
  if (WORKSPACE_WRITE_TOOLS.has(name)) {
    const paths = operationPaths(args);
    if (paths.length > 0) return paths.map((path) => ({ resourceKey: `path:${path}`, mode: 'write' }));
    return [{ resourceKey: `workspace:${checkoutId ?? 'active'}`, mode: 'write' }];
  }
  const paths = operationPaths(args);
  if (paths.length > 0) return paths.map((path) => ({ resourceKey: `path:${path}`, mode: 'write' }));
  return [];
}
