import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { collectRuntimePerformanceDiagnostics, inferLocalControllerProcess } from '../../diagnostics/performance';
import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import { listRepositories, repositorySummary, resolveRepositorySelection } from '../../../cli/repositories/registry';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { cancelExecutionJob, createExecutionJob, findExecutionJob, getExecutionJob, getExecutionJobByRequestId, listExecutionJobs } from '../../execution/jobs/store';
import type { ExecutionJob } from '../../execution/jobs/types';
import { readJobEvents } from '../../evidence/event-ledger';
import { readExecutionArtifact } from '../../evidence/artifact-store';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../control-plane/daemon-client';
import { readSchedulerHealthSnapshot } from '../../control-plane/global-scheduler/scheduler';
import { rebuildRepositoryProjection, readRepositoryProjectionSnapshot } from '../../projections/materialized-view';
import { applyScheduleDedupe, buildScheduleDedupeReport, createSchedule, getSchedule, getScheduleDecision, listOccurrences, listSchedules, saveSchedule } from '../../workflow/schedules/store';
import { evaluateSchedule } from '../../workflow/schedules/engine';
import { createPortfolioWorkflow, getPortfolioWorkflow, listPortfolioWorkflows } from '../../workflow/portfolio/store';
import { claimsForMcpOperation } from './resource-policy';
import { routeDurableMcpCall } from './router';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import { getCandidateFinding, listCandidateFindings, recordCandidateFinding, updateCandidateFinding } from '../../workflow/findings/store';
import { addCampaignTask, createCampaign, getCampaign, listCampaigns, setCampaignStatus, validateCreateCampaignTasks } from '../../workflow/campaigns/store';
import { reconcileCampaign } from '../../workflow/campaigns/engine';
import { submitCampaignReview } from '../../workflow/campaigns/review';
import type { CampaignReviewPolicy, CampaignSupervisorAction, CreateCampaignTaskInput } from '../../workflow/campaigns/types';
import { currentCampaignWorkspace, ensureCampaignWorkspace } from '../../workflow/campaigns/workspace';
import { cancelCampaign } from '../../workflow/campaigns/cleanup';
import {
  assertCampaignOperationSupported,
  normalizeCampaignDependencyReferences,
} from '../../workflow/campaigns/normalize';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { assessWorkMode } from '../../../cli/controller/work-mode';
import { projectBoard } from '../../../cli/controller/issue-store';
import {
  buildControllerTaskLedgerProjection,
  writeControllerTaskLedgerArtifacts,
} from '../../../cli/controller/task-ledger';
import { buildControllerContextPack } from '../../../cli/controller/context-pack';
import { listControllerChecks } from '../../../cli/controller/check-runner';
import { listActiveAgentJobSnapshots } from '../../../cli/agent-jobs/job-manager';
import {
  commitSelectedPaths,
  prepareFallbackHandoffArtifacts,
  selectedPathDiff,
  stageSelectedPaths,
} from '../../../cli/repositories/selected-path-actions';
import type { TaskRisk } from '../../../cli/controller/types';
import { controllerContextProjectionAgeMs, readControllerContextProjection } from '../../projections/controller-context';
import { loadMcpRuntimeState } from '../../../cli/mcp/auth';
import { redactMcpText } from '../../../cli/mcp/redaction';
import { getAssistantPluginManifest, listAssistantPluginManifests, submitAssistantPluginAction } from '../../plugins/store';
import {
  listWebTargets,
  mergeAllowedDomains,
  previewBrowserDomainAccess,
  resolveWebTargetUrl,
  summarizeJobResultForLowInterception,
  summarizePluginForLowInterception,
  applyExternalFilesystemGrant,
  buildWorkspaceAuthStatus,
  listExternalFilesystemTargets,
  prepareWorkspaceAuthLogin,
  previewExternalFilesystemGrant,
  readExternalFilesystemSnapshot,
  iosXcodeStatus,
  iosSimulatorsList,
  iosProjectDiscover,
  iosSchemesList,
  iosSimulatorBoot,
  iosAppBuild,
  iosAppInstall,
  iosAppLaunch,
  iosSimulatorScreenshot,
  iosSimulatorLogTail,
  iosUiSmokeTest,
  buildReviewArtifactIndex,
  ensureReviewArtifactRoots,
  prepareBrowserReviewPacket,
  prepareIosReviewPacket,
} from '../../safe-tooling';
import { buildModelClientSummary, buildModelControlPlaneSummary, deepSeekControllerManifest, deepSeekFunctionToolManifest, prepareDeepSeekControllerHandoff, prepareDeepSeekControllerRequest, prepareDeepSeekToolCall } from '../../model-clients';
import { buildAssistantReadinessReport } from '../../assistant/readiness';
import { buildGmailTriagePlan, readGmailTriageRules, upsertGmailTriageRule } from '../../personal-assistant/gmail-triage-manager';
import { gitSnapshot } from '../../../cli/repository/inspector';
import { buildWorkflowWatchdogReport } from '../../watchdog/workflow-watchdog';
import { applyRuntimeCleanup, previewRuntimeCleanup } from '../../maintenance/cleanup';
import {
  applyRuntimeMaintenance,
  buildCapabilityRecoverySnapshot,
  buildRuntimeMaintenanceStatus,
  buildSelfHealingLoopPlan,
  buildSelfHealingMonitorReport,
  recoveryActionById,
  buildRecoveryAuditRecord,
  assertRecoveryAuthorized,
  writeRecoveryAuditRecord,
  listRecoveryAuditRecords,
  type RuntimeMaintenanceActionId,
  previewRuntimeStorageRepair,
  applyRuntimeStorageRepair,
} from '../../recovery';
import {
  getLocalBridgeJobEventsSnapshot,
  getLocalBridgeJobSnapshot,
  listLocalBridgeJobSnapshots,
  readLocalBridgeJobOutputSnapshot,
} from '../../../cli/local-bridge/job-store';

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], readOnly = true): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: { readOnlyHint: readOnly, openWorldHint: false, destructiveHint: false },
  };
}
const repoId = { type: 'string', description: 'Stable repository id.' };
export const runtimeToolDefinitions: McpToolDefinition[] = [
  definition('work_submit', 'Submit one durable repository operation and return a resumable Work handle.', {
    repo_id: repoId,
    request_id: { type: 'string', description: 'Stable idempotency key used to resume the same Work after reconnecting.' },
    operation: { type: 'string', description: 'Existing durable controller operation, for example run_check, dispatch_task, or create_issue.' },
    arguments: { type: 'object', description: 'Arguments passed to the durable operation.' },
    timeout_ms: { type: 'number' },
  }, ['request_id', 'operation'], false),
  definition('work_get', 'Resume one Work by work_id or request_id. Repository scope is always enforced.', {
    repo_id: repoId,
    work_id: { type: 'string' },
    request_id: { type: 'string' },
    include_events: { type: 'boolean' },
  }),
  definition('work_list', 'List recent resumable Work for one repository.', {
    repo_id: repoId,
    limit: { type: 'number' },
  }),
  definition('work_cancel', 'Cancel one queued or running Work by work_id or request_id.', {
    repo_id: repoId,
    work_id: { type: 'string' },
    request_id: { type: 'string' },
    reason: { type: 'string' },
  }, [], false),
  definition('git_diff_paths', 'Return a bounded Git diff and status for explicit repository-relative paths only.', {
    repo_id: repoId,
    paths: { type: 'array', items: { type: 'string' } },
    staged: { type: 'boolean' },
    max_bytes: { type: 'number' },
  }, ['paths']),
  definition('git_stage_paths', 'Stage explicit repository-relative paths only using git add --all -- <paths>.', {
    repo_id: repoId,
    paths: { type: 'array', items: { type: 'string' } },
  }, ['paths'], false),
  definition('git_commit_paths', 'Stage and commit explicit repository-relative paths only, leaving unrelated staged changes untouched.', {
    repo_id: repoId,
    paths: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  }, ['paths', 'message'], false),
  definition('prepare_handoff_artifacts', 'Refresh repo-local handoff artifacts and fall back to minimal current/resume files when helper scripts are unavailable.', {
    repo_id: repoId,
    reason: { type: 'string' },
  }, [], false),
  definition('get_job', 'Read one durable Execution Job. Summary is the default; opt in to full state only when needed.', {
    job_id: { type: 'string' },
    repo_id: repoId,
    include_events: { type: 'boolean' },
    detail_level: { type: 'string', enum: ['summary', 'full'] },
  }, ['job_id']),
  definition('get_artifact', 'Read one bounded Evidence Plane artifact by id. Large content remains bounded.', { artifact_id: { type: 'string' }, repo_id: repoId, max_bytes: { type: 'number' } }, ['artifact_id', 'repo_id']),
  definition('list_jobs', 'List durable Execution Jobs for one repository. Summary is the default.', {
    repo_id: repoId,
    limit: { type: 'number' },
    detail_level: { type: 'string', enum: ['summary', 'full'] },
  }),
  definition('cancel_job', 'Cancel one queued or running durable Execution Job.', { job_id: { type: 'string' }, repo_id: repoId, reason: { type: 'string' } }, ['job_id'], false),
  definition('controller_ready', 'Return Gateway, Controller Daemon, Worker isolation, queue, and repository projection readiness.', { repo_id: repoId }),
  definition('repository_runtime_snapshot', 'Read the materialized runtime projection without scanning historical state.', { repo_id: repoId }),
  definition('schedule_dedupe_report', 'Read-only report that groups duplicate schedules by semantic trigger/action identity.', {
    repo_id: repoId,
  }, ['repo_id']),
  definition('schedule_dedupe_apply', 'Pause duplicate schedules after explicit authorization, keeping one canonical enabled schedule per semantic identity.', {
    repo_id: repoId,
    dry_run: { type: 'boolean', description: 'When true, only returns the proposed changes.' },
    confirm_authorization: { type: 'boolean', description: 'Must be true unless dry_run is true.' },
  }, ['repo_id']),
  definition('runtime_performance_diagnostics', 'Diagnose repo-harness host performance, orphan workers, Local Controller presence, and cleanup candidates.', {
    repo_id: repoId,
    include_processes: { type: 'boolean', description: 'Include bounded repo-harness related process samples. Defaults to true.' },
    include_temp_dirs: { type: 'boolean', description: 'Include bounded repo-harness temporary directory scan. Defaults to true.' },
    cleanup_preview: { type: 'boolean', description: 'Return a no-side-effect cleanup plan for orphan workers and stale temp entries.' },
  }),
  definition('capability_recovery_probe', 'Read-only capability recovery probe for daemon, bridge, scheduler, workers, connector, tools, plugins, and fallback state.', {
    repo_id: repoId,
    recent_errors: { type: 'array', items: { type: 'string' } },
    command_preview_available: { type: 'boolean' },
    command_execute_available: { type: 'boolean' },
    issue_tools_available: { type: 'boolean' },
    job_tools_available: { type: 'boolean' },
  }),
  definition('capability_recovery_plan', 'Return a deterministic recovery plan without mutating local state.', {
    repo_id: repoId,
    recent_errors: { type: 'array', items: { type: 'string' } },
  }),
  definition('capability_recovery_apply', 'Apply one bounded repo-harness recovery action after explicit authorization.', {
    repo_id: repoId,
    action_id: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
    authorization: { type: 'string', description: 'Must equal action_id for actions that require authorization.' },
    reason: { type: 'string' },
    min_age_minutes: { type: 'number' },
    max_candidates: { type: 'number' },
  }, ['action_id'], false),
  definition('runtime_maintenance_status', 'Read the self-contained runtime maintenance plan without using repository_command_execute or Local Job tickets.', {
    repo_id: repoId,
    min_age_minutes: { type: 'number' },
    max_candidates: { type: 'number' },
    cancel_pending_approvals: { type: 'boolean' },
    recent_errors: { type: 'array', items: { type: 'string' } },
  }),
  definition('runtime_maintenance_apply', 'Apply one bounded runtime maintenance action without repository_command_execute or Local Job tickets.', {
    repo_id: repoId,
    action_id: { type: 'string', enum: ['local_jobs_reconcile', 'quarantine_unreadable_local_jobs', 'runtime_storage_finalize_relocation', 'rebuild_projection', 'full_maintenance_pass'] },
    confirm_maintenance: { type: 'boolean' },
    authorization: { type: 'string', description: 'Must equal action_id.' },
    min_age_minutes: { type: 'number' },
    max_candidates: { type: 'number' },
    cancel_pending_approvals: { type: 'boolean' },
  }, ['action_id', 'confirm_maintenance', 'authorization'], false),
  definition('self_healing_loop_plan', 'Return the full self-healing loop plan, including local maintenance, restart fallback, and model-assisted source repair delegation.', {
    repo_id: repoId,
    objective: { type: 'string' },
    recent_errors: { type: 'array', items: { type: 'string' } },
    platform_blocked: { type: 'boolean' },
    source_defect_suspected: { type: 'boolean' },
    chatgpt_available: { type: 'boolean' },
    codex_cli_available: { type: 'boolean' },
    deepseek_available: { type: 'boolean' },
  }),
  definition('self_healing_monitor_tick', 'Run one read-only self-healing monitor pass across runtime storage, plugins, browser targets, external filesystem grants, and model repair fallback.', {
    repo_id: repoId,
    recent_errors: { type: 'array', items: { type: 'string' } },
    objective: { type: 'string' },
    active_mode: { type: 'boolean', description: 'Defaults to false. Active mode may recommend authorized local maintenance but still does not mutate state in this tool.' },
  }),
  definition('workspace_auth_status', 'Summarize Workspace/Gmail auth readiness without returning or persisting secrets.', {
    repo_id: repoId,
  }),
  definition('workspace_auth_login_prepare', 'Prepare a local Google Workspace/Gmail OAuth login handoff without receiving or storing secrets.', {
    repo_id: repoId,
    service: { type: 'string', enum: ['gmail', 'calendar', 'tasks', 'google-workspace'] },
    scopes: { type: 'array', items: { type: 'string' } },
    redirect_uri: { type: 'string' },
  }),
  definition('external_filesystem_targets_list', 'List pre-authorized external filesystem targets. Does not expose arbitrary absolute-path access.', {
    repo_id: repoId,
  }),
  definition('external_filesystem_grant_preview', 'Preview a read-only external filesystem grant for a narrow absolute directory without writing config.', {
    repo_id: repoId,
    grant_key: { type: 'string' },
    root_path: { type: 'string' },
    mode: { type: 'string', enum: ['read', 'copy_into_repo'] },
    expires_in_minutes: { type: 'number', description: 'Optional expiry in minutes, capped at 24h. Defaults to 8h.' },
    reason: { type: 'string' },
  }, ['grant_key', 'root_path', 'reason']),
  definition('external_filesystem_grant_apply', 'Apply a previously previewed read-only external filesystem grant with explicit authorization.', {
    repo_id: repoId,
    grant_key: { type: 'string' },
    root_path: { type: 'string' },
    mode: { type: 'string', enum: ['read', 'copy_into_repo'] },
    expires_in_minutes: { type: 'number', description: 'Optional expiry in minutes, capped at 24h. Defaults to 8h.' },
    reason: { type: 'string' },
    preview_ticket_id: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
  }, ['grant_key', 'root_path', 'reason', 'preview_ticket_id', 'confirm_authorization'], false),
  definition('external_filesystem_text_snapshot', 'Read a bounded text/directory snapshot from a pre-authorized external filesystem target key.', {
    repo_id: repoId,
    target_key: { type: 'string' },
    path: { type: 'string' },
    max_chars: { type: 'number' },
  }, ['target_key']),
  definition('runtime_storage_repair_preview', 'Preview repo-scoped local-jobs runtime storage repair candidates without mutation.', {
    repo_id: repoId,
    min_age_minutes: { type: 'number' },
    max_candidates: { type: 'number' },
  }),
  definition('runtime_storage_repair_apply', 'Apply safe repo-scoped local-jobs runtime storage repairs after explicit confirmation.', {
    repo_id: repoId,
    candidate_ids: { type: 'array', items: { type: 'string' } },
    min_age_minutes: { type: 'number' },
    max_candidates: { type: 'number' },
    confirm_repair: { type: 'boolean' },
  }, ['confirm_repair'], false),
  definition('list_plugins', 'List personal-assistant plugin manifests, lifecycle state, health, and action discovery for one repository.', {
    repo_id: repoId,
  }),
  definition('get_plugin', 'Read one personal-assistant plugin manifest including action schemas and policy requirements.', {
    repo_id: repoId,
    plugin_id: { type: 'string' },
  }, ['plugin_id']),
  definition('plugin_action_execute', 'Submit one typed personal-assistant plugin action through the durable execution layer.', {
    repo_id: repoId,
    plugin_id: { type: 'string' },
    action_id: { type: 'string' },
    request_id: { type: 'string' },
    arguments: { type: 'object' },
    timeout_ms: { type: 'number' },
    confirm_authorization: { type: 'boolean' },
    confirmation_text: { type: 'string' },
  }, ['plugin_id', 'action_id', 'request_id'], false),
  definition('toolchain_plugin_summary', 'Return a redacted, low-interception plugin summary without raw config files or full action schemas.', {
    repo_id: repoId,
    plugin_id: { type: 'string' },
  }, ['plugin_id']),
  definition('web_targets_list', 'List pre-allowed web targets as domain keys. This avoids arbitrary URL parameters.', {
    repo_id: repoId,
  }),
  definition('web_target_snapshot', 'Create a read-only browser snapshot for a pre-allowed web target by target_key and path. Does not accept arbitrary URLs.', {
    repo_id: repoId,
    target_key: { type: 'string' },
    path: { type: 'string' },
    query: { type: 'object' },
    capture: { type: 'string', enum: ['title', 'text', 'screenshot'] },
    wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
    max_chars: { type: 'number' },
    full_page: { type: 'boolean' },
    request_id: { type: 'string' },
    timeout_ms: { type: 'number' },
  }, ['target_key', 'request_id'], false),
  definition('web_domain_access_preview', 'Preview a browser domain access request without writing plugin config or accepting arbitrary URLs.', {
    repo_id: repoId,
    domain: { type: 'string' },
    reason: { type: 'string' },
  }, ['domain']),
  definition('web_domain_access_apply', 'Apply a previously previewed browser domain access request through browser configuration with explicit authorization.', {
    repo_id: repoId,
    domain: { type: 'string' },
    reason: { type: 'string' },
    preview_ticket_id: { type: 'string' },
    request_id: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
  }, ['domain', 'request_id', 'confirm_authorization'], false),
  definition('work_result_summary', 'Return a redacted job result summary with failure class and suggested next actions. Does not return raw stdout or stderr.', {
    repo_id: repoId,
    job_id: { type: 'string' },
  }, ['job_id']),
  definition('work_status_digest', 'Return a redacted work status digest using a neutral work_ref. Does not return raw stdout or stderr.', {
    repo_id: repoId,
    work_ref: { type: 'string' },
  }, ['work_ref']),
  definition('model_clients_summary', 'List enabled model clients and DeepSeek adapter configuration state. Policy remains enforced by repo-harness.', {
    repo_id: repoId,
  }),
  definition('model_control_plane_summary', 'Summarize primary and backup model controllers, handoff modes, and concurrency policy.', {
    repo_id: repoId,
  }),
  definition('deepseek_tool_manifest', 'Return DeepSeek function-calling tool manifests for the low-interception repo-harness surface.', {
    repo_id: repoId,
  }),
  definition('deepseek_tool_call_prepare', 'Translate one DeepSeek function call into a repo-harness operation without executing it.', {
    repo_id: repoId,
    function_name: { type: 'string' },
    function_arguments: { type: 'object' },
  }, ['function_name', 'function_arguments']),
  definition('deepseek_controller_manifest', 'Return DeepSeek backup-controller manifest, boundaries, and function tools.', {
    repo_id: repoId,
  }),
  definition('deepseek_controller_handoff_prepare', 'Prepare a safe DeepSeek backup-controller handoff packet without calling the external model.', {
    repo_id: repoId,
    reason: { type: 'string', enum: ['manual', 'chatgpt_platform_blocked', 'chatgpt_unavailable', 'parallel_review', 'local_gui_request'] },
    objective: { type: 'string' },
    current_controller: { type: 'string' },
    blocked_tool_name: { type: 'string' },
    recent_safe_error: { type: 'string' },
  }),
  definition('deepseek_controller_request_prepare', 'Prepare a DeepSeek chat-completions request for backup controller mode without sending it.', {
    repo_id: repoId,
    reason: { type: 'string', enum: ['manual', 'chatgpt_platform_blocked', 'chatgpt_unavailable', 'parallel_review', 'local_gui_request'] },
    objective: { type: 'string' },
    user_message: { type: 'string' },
    current_controller: { type: 'string' },
    blocked_tool_name: { type: 'string' },
    recent_safe_error: { type: 'string' },
    model: { type: 'string' },
  }),
  definition('assistant_readiness', 'Summarize personal-assistant readiness, Google plugin state, routines, inbox, and recommended next actions.', {
    repo_id: repoId,
  }),
  definition('gmail_triage_rules', 'Read repository-local Gmail triage rules used by the personal assistant manager.', { repo_id: repoId }),
  definition('gmail_triage_rule_upsert', 'Create or update one repository-local Gmail triage rule. This only changes repo-local assistant configuration.', {
    repo_id: repoId,
    id: { type: 'string' },
    enabled: { type: 'boolean' },
    order: { type: 'number' },
    match: { type: 'object' },
    decision: { type: 'object' },
  }, ['id', 'match', 'decision'], false),
  definition('gmail_triage_plan', 'Build a safe Gmail triage plan from supplied message summaries and current Gmail plugin readiness. Does not mutate Gmail.', {
    repo_id: repoId,
    query: { type: 'string' },
    items: { type: 'array', items: { type: 'object' } },
  }),
  definition('review_artifacts_prepare', 'Create bounded repo-local review artifact roots for browser/iOS screenshot review workflows.', { repo_id: repoId }, [], false),
  definition('review_artifacts_index', 'Index bounded repo-local browser/iOS screenshots, logs, and build reports for visual review.', { repo_id: repoId, limit: { type: 'number' } }),
  definition('browser_review_packet', 'Build a browser visual review packet from indexed browser screenshots.', { repo_id: repoId, limit: { type: 'number' } }),
  definition('ios_review_packet', 'Build or capture an iOS visual review packet from simulator screenshots and logs.', {
    repo_id: repoId,
    udid: { type: 'string' },
    label: { type: 'string' },
    capture: { type: 'boolean' },
    limit: { type: 'number' },
  }, [], false),
  definition('workflow_watchdog_report', 'Diagnose stuck repository workflows across execution jobs, local bridge jobs, schedules, and runtime processes.', {
    repo_id: repoId,
    stale_minutes: { type: 'number' },
    include_processes: { type: 'boolean' },
  }),
  definition('ios_xcode_status', 'Check local Xcode, xcodebuild, and simctl availability without mutation.', { repo_id: repoId }),
  definition('ios_simulators_list', 'List available iOS Simulator devices using structured simctl JSON output.', {
    repo_id: repoId,
    runtime: { type: 'string' },
    name: { type: 'string' },
  }),
  definition('ios_project_discover', 'Discover iOS workspaces, projects, Package.swift, and Info.plist files inside the repository.', { repo_id: repoId }),
  definition('ios_schemes_list', 'List Xcode schemes for a repository-bounded workspace or project.', {
    repo_id: repoId,
    workspace: { type: 'string' },
    project: { type: 'string' },
  }),
  definition('ios_simulator_boot', 'Boot an explicitly selected iOS Simulator UDID. Requires authorization.', {
    repo_id: repoId,
    udid: { type: 'string' },
    open_simulator: { type: 'boolean' },
    confirm_authorization: { type: 'boolean' },
    timeout_ms: { type: 'number' },
  }, ['udid', 'confirm_authorization'], false),
  definition('ios_app_build', 'Build an iOS app into .repo-harness/ios/DerivedData using xcodebuild structured arguments.', {
    repo_id: repoId,
    scheme: { type: 'string' },
    udid: { type: 'string' },
    workspace: { type: 'string' },
    project: { type: 'string' },
    configuration: { type: 'string' },
    timeout_ms: { type: 'number' },
  }, ['scheme'], false),
  definition('ios_app_install', 'Install a bounded .app product from .repo-harness/ios/DerivedData into a booted simulator. Requires authorization.', {
    repo_id: repoId,
    udid: { type: 'string' },
    app_path: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
  }, ['udid', 'app_path', 'confirm_authorization'], false),
  definition('ios_app_launch', 'Launch a simulator app by bundle id with structured launch arguments. Requires authorization.', {
    repo_id: repoId,
    udid: { type: 'string' },
    bundle_id: { type: 'string' },
    arguments: { type: 'array', items: { type: 'string' } },
    confirm_authorization: { type: 'boolean' },
  }, ['udid', 'bundle_id', 'confirm_authorization'], false),
  definition('ios_simulator_screenshot', 'Capture a simulator screenshot to .repo-harness/ios/screenshots as a bounded artifact.', {
    repo_id: repoId,
    udid: { type: 'string' },
    label: { type: 'string' },
  }, ['udid'], false),
  definition('ios_simulator_log_tail', 'Collect a bounded recent simulator log tail into .repo-harness/ios/logs.', {
    repo_id: repoId,
    udid: { type: 'string' },
    process: { type: 'string' },
    last: { type: 'string' },
    max_bytes: { type: 'number' },
  }),
  definition('ios_ui_smoke_test', 'Compose build, boot, launch, screenshot, and bounded logs for simulator UI review. Requires authorization.', {
    repo_id: repoId,
    udid: { type: 'string' },
    scheme: { type: 'string' },
    bundle_id: { type: 'string' },
    workspace: { type: 'string' },
    project: { type: 'string' },
    configuration: { type: 'string' },
    app_path: { type: 'string' },
    screenshot_label: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
  }, ['udid', 'scheme', 'bundle_id', 'confirm_authorization'], false),
  definition('runtime_cleanup_preview', 'Preview stale repo-harness temp directories, terminal local jobs, and historical attention cleanup candidates.', {
    repo_id: repoId,
    min_age_minutes: { type: 'number' },
    include_temp_dirs: { type: 'boolean' },
    include_terminal_local_jobs: { type: 'boolean' },
    include_legacy_runs: { type: 'boolean' },
    include_historical_attention: { type: 'boolean' },
    max_candidates: { type: 'number' },
  }),
  definition('runtime_cleanup_apply', 'Apply safe cleanup candidates. Requires confirm_cleanup=true and remains limited to explicit repo-harness candidates.', {
    repo_id: repoId,
    min_age_minutes: { type: 'number' },
    include_temp_dirs: { type: 'boolean' },
    include_terminal_local_jobs: { type: 'boolean' },
    include_legacy_runs: { type: 'boolean' },
    include_historical_attention: { type: 'boolean' },
    max_candidates: { type: 'number' },
    confirm_cleanup: { type: 'boolean' },
  }, [], false),
  definition('create_campaign', 'Create a durable ChatGPT-supervised repository campaign.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional source checkout used to create the Campaign workspace.' },
    request_id: { type: 'string' },
    semantic_key: { type: 'string' },
    title: { type: 'string' },
    goal: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    non_goals: { type: 'array', items: { type: 'string' } },
    review_policy: { type: 'string', enum: ['every_task', 'failures_and_final', 'final_only'] },
    tasks: { type: 'array', items: { type: 'object' } },
    budget: { type: 'object' },
    supervisor: { type: 'object' },
    workspace: { type: 'object', description: 'Workspace policy. Defaults to an isolated long-lived Campaign worktree. Set mode=current to opt out.' },
  }, ['request_id', 'title', 'goal', 'tasks'], false),
  definition('list_campaigns', 'List durable campaigns for one repository.', { repo_id: repoId, limit: { type: 'number' } }),
  definition('get_campaign', 'Read one durable campaign.', { repo_id: repoId, campaign_id: { type: 'string' } }, ['campaign_id']),
  definition('add_campaign_task', 'Add one task to a non-terminal campaign.', {
    repo_id: repoId,
    campaign_id: { type: 'string' },
    request_id: { type: 'string' },
    expected_revision: { type: 'number' },
    task: { type: 'object' },
  }, ['campaign_id', 'request_id', 'task'], false),
  definition('pause_campaign', 'Pause a campaign without holding execution resources.', {
    repo_id: repoId, campaign_id: { type: 'string' }, request_id: { type: 'string' }, expected_revision: { type: 'number' }, reason: { type: 'string' },
  }, ['campaign_id', 'request_id'], false),
  definition('resume_campaign', 'Resume a paused or supervisor-waiting campaign.', {
    repo_id: repoId, campaign_id: { type: 'string' }, request_id: { type: 'string' }, expected_revision: { type: 'number' },
  }, ['campaign_id', 'request_id'], false),
  definition('cancel_campaign', 'Cancel a campaign and reconcile child Jobs and managed workspace resources before reaching a terminal state.', {
    repo_id: repoId, campaign_id: { type: 'string' }, request_id: { type: 'string' }, expected_revision: { type: 'number' }, reason: { type: 'string' },
  }, ['campaign_id', 'request_id'], false),
  definition('get_campaign_review_packet', 'Read one bounded open review packet for ChatGPT or another supervisor.', {
    repo_id: repoId, campaign_id: { type: 'string' }, checkpoint_id: { type: 'string' },
  }, ['campaign_id']),
  definition('submit_campaign_review', 'Submit one nonce- and goal-revision-bound supervisor decision.', {
    repo_id: repoId,
    campaign_id: { type: 'string' },
    checkpoint_id: { type: 'string' },
    checkpoint_nonce: { type: 'string' },
    goal_revision: { type: 'number' },
    expected_campaign_revision: { type: 'number' },
    request_id: { type: 'string' },
    action: { type: 'string', enum: ['accept', 'request_changes', 'retry', 'skip', 'pause', 'resume', 'approve_final', 'revise_goal', 'escalate'] },
    summary: { type: 'string' },
    instructions: { type: 'string' },
    revised_goal: { type: 'object' },
    submitted_by: { type: 'string' },
  }, ['campaign_id', 'checkpoint_id', 'checkpoint_nonce', 'goal_revision', 'request_id', 'action', 'summary'], false),
  definition('accept_campaign', 'Record human acceptance after final supervisor approval.', {
    repo_id: repoId, campaign_id: { type: 'string' }, request_id: { type: 'string' }, expected_revision: { type: 'number' },
  }, ['campaign_id', 'request_id'], false),
  definition('reconcile_campaign', 'Run one bounded campaign reconciliation pass immediately.', {
    repo_id: repoId, campaign_id: { type: 'string' },
  }, ['campaign_id'], false),
  definition('create_schedule', 'Create a bounded repository Schedule. Shadow mode defaults to true.', {
    repo_id: repoId,
    request_id: { type: 'string' },
    name: { type: 'string' },
    trigger_type: { type: 'string', enum: ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'] },
    every_minutes: { type: 'number' },
    cron_expression: { type: 'string' },
    calendar_at: { type: 'string' },
    condition: { type: 'object' },
    event_name: { type: 'string' },
    dependency_job_ids: { type: 'array', items: { type: 'string' } },
    operation: { type: 'string' },
    arguments: { type: 'object' },
    shadow_mode: { type: 'boolean' },
    daily_budget_minutes: { type: 'number' },
    cooldown_minutes: { type: 'number' },
    backoff_base_minutes: { type: 'number' },
    backoff_max_minutes: { type: 'number' },
    max_failures: { type: 'number' },
    stop_conditions: { type: 'array', items: { type: 'string' } },
  }, ['name', 'operation'], false),
  definition('list_schedules', 'List repository Schedules and recent bounded Occurrences.', { repo_id: repoId, include_occurrences: { type: 'boolean' } }),
  definition('pause_schedule', 'Pause a repository Schedule.', { repo_id: repoId, schedule_id: { type: 'string' }, reason: { type: 'string' } }, ['schedule_id'], false),
  definition('trigger_schedule', 'Create one idempotent bounded Occurrence for a Schedule or deliver a repository event.', {
    repo_id: repoId,
    schedule_id: { type: 'string' },
    event_name: { type: 'string' },
    event_id: { type: 'string' },
    event_data: { type: 'object' },
  }, ['schedule_id'], false),
  definition('request_release_gate', 'Create a durable exclusive Release Gate Job. Push, tag, and publish remain separately authorized.', { repo_id: repoId, request_id: { type: 'string' } }, [], false),
  definition('create_portfolio_workflow', 'Create a cross-repository DAG with deterministic Saga stop/compensation semantics.', {
    name: { type: 'string' }, request_id: { type: 'string' }, failure_policy: { type: 'string', enum: ['stop', 'compensate'] }, steps: { type: 'array', items: { type: 'object' } },
  }, ['name', 'request_id', 'steps'], false),
  definition('list_portfolio_workflows', 'List cross-repository Portfolio workflows.', { limit: { type: 'number' } }),
  definition('get_portfolio_workflow', 'Read one Portfolio workflow and its repository DAG state.', { workflow_id: { type: 'string' } }, ['workflow_id']),
  definition('record_candidate_finding', 'Record or refresh a deduplicated candidate requirement without creating an Issue automatically.', {
    repo_id: repoId, request_id: { type: 'string' }, semantic_key: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, reference: { type: 'string' }, evidence: { type: 'object' },
  }, ['semantic_key', 'title'], false),
  definition('list_candidate_findings', 'List bounded candidate findings awaiting human promotion or dismissal.', { repo_id: repoId, include_terminal: { type: 'boolean' }, limit: { type: 'number' } }),
  definition('promote_candidate_finding', 'Explicitly promote one candidate finding into a durable Issue-creation Job.', {
    repo_id: repoId, finding_id: { type: 'string' }, request_id: { type: 'string' }, kind: { type: 'string', enum: ['bug', 'feature', 'governance', 'investigation'] }, goals: { type: 'array', items: { type: 'string' } }, acceptance_criteria: { type: 'array', items: { type: 'string' } },
  }, ['finding_id'], false),
];

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function repositoryRootForRepoId(controllerHome: string, repoId: string): string | undefined {
  return listRepositories(controllerHome).find((repository) => repository.repoId === repoId)?.canonicalRoot;
}

function scrubPathText(text: string, replacements: string[]): string {
  let output = text;
  for (const replacement of [...new Set(replacements.filter((entry) => entry.startsWith('/')))].sort((left, right) => right.length - left.length)) {
    output = output.split(replacement).join('<repo>');
  }
  output = output
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>');
  return output;
}

function jsonPreview(value: unknown, maxChars = 800, replacements: string[] = []): { preview: string; truncated: boolean; byteLength: number } {
  const serialized = JSON.stringify(value);
  const redacted = redactMcpText(scrubPathText(serialized, replacements)).text;
  const byteLength = Buffer.byteLength(serialized);
  if (redacted.length <= maxChars) return { preview: redacted, truncated: false, byteLength };
  return {
    preview: `${redacted.slice(0, maxChars)}...`,
    truncated: true,
    byteLength,
  };
}

function summarizeJobEvents(controllerHome: string, repoId: string, jobId: string): Array<Record<string, unknown>> {
  const repoRoot = repositoryRootForRepoId(controllerHome, repoId);
  return readJobEvents(controllerHome, repoId, jobId).slice(-20).map((event) => {
    const dataPreview = event.data && Object.keys(event.data).length > 0 ? jsonPreview(event.data, 240, repoRoot ? [repoRoot] : []) : undefined;
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      revision: event.revision,
      ...(dataPreview ? { dataPreview: dataPreview.preview, dataTruncated: dataPreview.truncated } : {}),
    };
  });
}

function summarizeExecutionJob(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  const payloadArguments = job.payload.arguments && typeof job.payload.arguments === 'object'
    ? Object.keys(job.payload.arguments as Record<string, unknown>).slice(0, 20)
    : undefined;
  const replacements = repoRoot ? [repoRoot] : [];
  const resultPreview = job.result !== undefined ? jsonPreview(job.result, 320, replacements) : undefined;
  const errorPreview = job.error?.details !== undefined ? jsonPreview(job.error.details, 320, replacements) : undefined;
  return {
    jobId: job.jobId,
    repoId: job.repoId,
    checkoutId: job.checkoutId,
    type: job.type,
    status: job.status,
    priority: job.priority,
    requestId: job.requestId,
    semanticKey: job.semanticKey,
    payload: {
      operation: job.payload.operation,
      target: job.payload.target,
      profile: job.payload.profile,
      timeoutMs: job.payload.timeoutMs,
      maxOutputBytes: job.payload.maxOutputBytes,
      argumentKeys: payloadArguments,
      summaryOnly: true,
    },
    origin: job.origin,
    resourceClaims: job.resourceClaims.map((claim) => ({
      resourceKey: redactMcpText(scrubPathText(claim.resourceKey, replacements)).text,
      mode: claim.mode,
    })),
    dependencyCount: job.dependencies.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    heartbeatAt: job.heartbeatAt,
    deadlineAt: job.deadlineAt,
    workerPid: job.workerPid,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    evidenceCount: job.evidenceIds.length,
    outcome: job.outcome ? {
      infrastructureError: job.outcome.infrastructureError ? {
        code: job.outcome.infrastructureError.code,
        message: redactMcpText(scrubPathText(job.outcome.infrastructureError.message, replacements)).text,
      } : undefined,
    } : undefined,
    result: resultPreview
      ? {
        preview: resultPreview.preview,
        truncated: resultPreview.truncated,
        byteLength: resultPreview.byteLength,
        next: 'Call get_job with detail_level=full or get_artifact if an artifactId is present.',
      }
      : undefined,
    error: job.error
      ? {
        code: job.error.code,
        message: redactMcpText(scrubPathText(job.error.message, replacements)).text,
        retryable: job.error.retryable,
        ...(errorPreview
          ? {
            detailsPreview: errorPreview.preview,
            detailsTruncated: errorPreview.truncated,
            detailsByteLength: errorPreview.byteLength,
          }
          : {}),
      }
      : undefined,
  };
}

function summarizeRuntimeProjectionForReadiness<T extends { currentAttention?: unknown; attention?: unknown }>(projection: T): T & { historicalAttention?: unknown } {
  return {
    ...projection,
    attention: projection.currentAttention ?? projection.attention,
    historicalAttention: projection.attention,
  };
}

function summarizePlugin(manifest: ReturnType<typeof getAssistantPluginManifest>): Record<string, unknown> {
  return {
    pluginId: manifest.pluginId,
    provider: manifest.provider,
    displayName: manifest.displayName,
    pluginVersion: manifest.pluginVersion,
    revision: manifest.revision,
    enabled: manifest.enabled,
    lifecycle: manifest.lifecycle,
    health: manifest.health,
    authority: manifest.authority,
    permissions: manifest.permissions,
    capabilities: manifest.capabilities,
    actions: manifest.actions.map((action) => ({
      actionId: action.actionId,
      title: action.title,
      description: action.description,
      readOnly: action.readOnly,
      risk: action.risk,
      confirmation: action.confirmation,
      requiredConfirmationText: action.requiredConfirmationText,
      defaultTimeoutMs: action.defaultTimeoutMs,
      cancellable: action.cancellable,
      idempotent: action.idempotent,
      scopes: action.scopes,
      resourceClaims: action.resourceClaims,
      argumentsSchema: action.argumentsSchema,
    })),
    updatedAt: manifest.updatedAt,
  };
}


function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}

function controllerContextAssessment(args: Record<string, unknown>) {
  if (typeof args.description !== 'string' || !args.description.trim()) return undefined;
  return assessWorkMode({
    description: args.description,
    knownPaths: stringList(args.known_paths),
    expectedFiles: typeof args.expected_files === 'number' ? args.expected_files : undefined,
    expectedChangedLines: typeof args.expected_changed_lines === 'number' ? args.expected_changed_lines : undefined,
    requiresInvestigation: args.requires_investigation === true,
    requiresParallelism: args.requires_parallelism === true,
    requiresLongRunningChecks: args.requires_long_running_checks === true,
    needsDependencies: args.needs_dependencies === true,
    risk: typeof args.risk === 'string' ? args.risk as TaskRisk : undefined,
  });
}

function selected(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>) {
  return resolveRepositorySelection({
    repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
    checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
    explicitPath: ctx.explicitRepository?.canonicalRoot,
    controllerHome: ctx.controllerHome,
    allowSoleRepository: true,
  });
}

const CAMPAIGN_AGENT_OPERATIONS = new Set(['dispatch_task', 'launch_issue', 'dispatch_ready_tasks', 'retry_task_run', 'quick_agent_session']);
const CAMPAIGN_CONTROL_OPERATIONS = new Set(['create_campaign', 'add_campaign_task', 'pause_campaign', 'resume_campaign', 'cancel_campaign', 'submit_campaign_review', 'accept_campaign', 'reconcile_campaign']);

function campaignTaskInput(
  raw: unknown,
  repoIdValue: string,
  checkoutId?: string,
): CreateCampaignTaskInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CAMPAIGN_TASK_INVALID');
  const value = raw as Record<string, unknown>;
  const taskId = String(value.task_id ?? value.taskId ?? '').trim();
  const title = String(value.title ?? '').trim();
  const rawOperation = String(value.operation ?? '').trim();
  const operation = rawOperation ? assertCampaignOperationSupported(rawOperation) : '';
  if (!taskId || !title || !operation) throw new Error('CAMPAIGN_TASK_INVALID: task_id, title, and operation are required');
  if (CAMPAIGN_CONTROL_OPERATIONS.has(operation)) throw new Error(`CAMPAIGN_RECURSIVE_OPERATION_DENIED: ${operation}`);
  const argumentsValue = value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)
    ? { ...(value.arguments as Record<string, unknown>) }
    : {};
  if (CAMPAIGN_AGENT_OPERATIONS.has(operation)) argumentsValue.isolate = true;
  assertAutomatedOperationAllowed(operation, argumentsValue);
  const requestedClaims = Array.isArray(value.resource_claims)
    ? value.resource_claims.flatMap((rawClaim) => {
      if (!rawClaim || typeof rawClaim !== 'object') return [];
      const claim = rawClaim as Record<string, unknown>;
      const resourceKey = String(claim.resource_key ?? claim.resourceKey ?? '').trim();
      const mode = String(claim.mode ?? 'write');
      if (!resourceKey || !['read', 'write', 'exclusive'].includes(mode)) return [];
      return [{ resourceKey, mode: mode as 'read' | 'write' | 'exclusive' }];
    })
    : [];
  const executor = value.executor && typeof value.executor === 'object' && !Array.isArray(value.executor)
    ? value.executor as Record<string, unknown>
    : undefined;
  return {
    taskId,
    title,
    objective: typeof value.objective === 'string' ? value.objective : undefined,
    operation,
    arguments: argumentsValue,
    dependsOn: normalizeCampaignDependencyReferences(Array.isArray(value.depends_on ?? value.dependsOn) ? (value.depends_on ?? value.dependsOn) as unknown[] : []),
    priority: ['P0', 'P1', 'P2', 'P3', 'P4'].includes(String(value.priority)) ? String(value.priority) as 'P0' | 'P1' | 'P2' | 'P3' | 'P4' : 'P1',
    resourceClaims: requestedClaims.length > 0 ? requestedClaims : claimsForMcpOperation(operation, argumentsValue, repoIdValue, checkoutId),
    reviewRequired: value.review_required === undefined ? true : value.review_required === true,
    requiresChanges: value.requires_changes === true || value.requiresChanges === true,
    maxAttempts: typeof value.max_attempts === 'number' ? value.max_attempts : undefined,
    executor: executor ? {
      enableDevRunner: executor.enable_dev_runner === undefined ? undefined : executor.enable_dev_runner === true,
      enableChatgptBrowser: executor.enable_chatgpt_browser === true,
      allowedAgents: Array.isArray(executor.allowed_agents) ? executor.allowed_agents.map(String) : undefined,
      runnerTimeoutMs: typeof executor.runner_timeout_ms === 'number' ? executor.runner_timeout_ms : undefined,
      runnerMaxTimeoutMs: typeof executor.runner_max_timeout_ms === 'number' ? executor.runner_max_timeout_ms : undefined,
    } : undefined,
  };
}

function expectedRevision(args: Record<string, unknown>, key = 'expected_revision'): number | undefined {
  return typeof args[key] === 'number' ? Math.trunc(args[key] as number) : undefined;
}

const SCHEDULER_HEARTBEAT_STALE_MS = 5_000;
const QUEUE_PROGRESS_STALE_MS = 10_000;

function ageMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : undefined;
}

function controllerReadiness(ctx: MultiRepositoryMcpToolContext, repository = ctx.explicitRepository) {
  const daemon = readControllerDaemonStatus(ctx.controllerHome);
  const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
  const projection = repository ? readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId).projection : undefined;
  const localBridge = repository ? loadMcpRuntimeState(repository.canonicalRoot)?.localController : undefined;
  const inferredLocalBridge = repository ? inferLocalControllerProcess(repository.canonicalRoot) : undefined;
  const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
  const dispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
  const schedulerFresh = daemon.status === 'ready'
    && schedulerHeartbeatAgeMs !== undefined
    && schedulerHeartbeatAgeMs <= SCHEDULER_HEARTBEAT_STALE_MS;
  const reasons: Array<{ code: string; message: string }> = [];

  if (daemon.status !== 'ready') {
    reasons.push({
      code: 'DAEMON_NOT_READY',
      message: `Controller daemon is ${daemon.status}.`,
    });
  }

  if (projection?.queueDepth && !schedulerFresh) {
    reasons.push({
      code: 'DISPATCH_LOOP_STALLED',
      message: 'The durable scheduler heartbeat is stale while queued Jobs are waiting.',
    });
  }

  if (projection?.queueDepth && projection.runningWorkers === 0 && projection.activeLeases === 0) {
    reasons.push({
      code: 'WORKER_NOT_RUNNING',
      message: 'Queued Jobs exist but no Worker is currently running.',
    });
    if (dispatchHeartbeatAgeMs === undefined || dispatchHeartbeatAgeMs > QUEUE_PROGRESS_STALE_MS) {
      reasons.push({
        code: 'QUEUE_NOT_PROGRESSING',
        message: 'Queued Jobs have not received a recent dispatch heartbeat.',
      });
    }
  }

  const ready = reasons.length === 0;
  return {
    ready,
    state: ready ? 'ready' as const : daemon.status === 'ready' ? 'degraded' as const : 'not_ready' as const,
    reasons,
    daemon,
    durableScheduler: {
      status: schedulerFresh ? 'ready' : daemon.status === 'ready' ? 'degraded' : 'not_ready',
      loopStartedAt: scheduler.loopStartedAt,
      lastTickAt: scheduler.lastTickAt,
      lastDispatchAt: scheduler.lastDispatchAt,
      lastReconcileAt: scheduler.lastReconcileAt,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs,
    },
    workerLoop: {
      status: projection?.runningWorkers ? 'running' : projection?.queueDepth ? 'idle' : 'ready',
      queueDepth: projection?.queueDepth ?? 0,
      runningWorkers: projection?.runningWorkers ?? 0,
      activeLeases: projection?.activeLeases ?? 0,
      consuming: (projection?.queueDepth ?? 0) === 0 || (projection?.runningWorkers ?? 0) > 0,
    },
    localBridge: repository ? {
      running: localBridge?.running ?? inferredLocalBridge?.running ?? false,
      endpoint: localBridge?.endpoint ?? inferredLocalBridge?.endpoint,
      error: localBridge?.error,
      inferredPid: inferredLocalBridge?.pid,
      statusSource: localBridge?.running ? 'runtime-state' : inferredLocalBridge ? 'process-scan' : 'runtime-state',
    } : undefined,
    projection,
  };
}

function capabilityRecoveryInput(ctx: MultiRepositoryMcpToolContext, repository: ReturnType<typeof selected>, args: Record<string, unknown>) {
  const readiness = controllerReadiness(ctx, repository);
  const runtimeSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
  const localBridge = loadMcpRuntimeState(repository.canonicalRoot)?.localController;
  const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
  const contextProjection = readControllerContextProjection(ctx.controllerHome, repository.repoId);
  const contextProjectionAgeMs = controllerContextProjectionAgeMs(contextProjection);
  const recentErrors = Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : [];
  let runtimeStorageReady: boolean | undefined;
  let runtimeStorageWarnings: string[] = [];
  try {
    const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
    runtimeStorageReady = runtimeStorage.readyForExecution;
    runtimeStorageWarnings = runtimeStorage.warnings;
  } catch (error) {
    runtimeStorageReady = false;
    runtimeStorageWarnings = [error instanceof Error ? error.message : String(error)];
  }
  const plugins = listAssistantPluginManifests(ctx.controllerHome, repository);
  const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 30);
  const executionJobs = listExecutionJobs(ctx.controllerHome, repository.repoId, 30);
  return {
    generatedAt: new Date().toISOString(),
    daemonStatus: readiness.daemon.status,
    daemonError: readiness.daemon.error,
    schedulerStatus: readiness.durableScheduler.status,
    schedulerHeartbeatAgeMs: readiness.durableScheduler.heartbeatAgeMs,
    schedulerDispatchHeartbeatAgeMs: readiness.durableScheduler.dispatchHeartbeatAgeMs,
    queueDepth: readiness.workerLoop.queueDepth,
    runningWorkers: readiness.workerLoop.runningWorkers,
    activeLeases: readiness.workerLoop.activeLeases,
    localBridgeRunning: localBridge?.running ?? inferredLocalBridge?.running,
    localBridgeError: localBridge?.error,
    connectorHealthy: undefined,
    runtimeProjectionStale: runtimeSnapshot.stale,
    runtimeProjectionPersisted: runtimeSnapshot.persisted,
    contextProjectionStale: Number.isFinite(contextProjectionAgeMs) ? contextProjectionAgeMs > 30_000 : undefined,
    commandPreviewAvailable: args.command_preview_available === undefined ? true : args.command_preview_available === true,
    commandExecuteAvailable: args.command_execute_available === undefined ? true : args.command_execute_available === true,
    issueToolsAvailable: args.issue_tools_available === undefined ? true : args.issue_tools_available === true,
    jobToolsAvailable: args.job_tools_available === undefined ? true : args.job_tools_available === true,
    checksAvailable: listControllerChecks(repository.canonicalRoot).length > 0,
    runtimeStorageReady,
    runtimeStorageWarnings,
    pluginStates: plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      healthState: plugin.health.state,
      ready: plugin.health.ready,
      errors: plugin.health.errors,
      warnings: plugin.health.warnings,
    })),
    recentErrors,
    localJobs: localJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt })),
    executionJobs: executionJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt, operation: job.payload.operation })),
  };
}

function capabilityRecoverySnapshot(ctx: MultiRepositoryMcpToolContext, repository: ReturnType<typeof selected>, args: Record<string, unknown>) {
  return buildCapabilityRecoverySnapshot(capabilityRecoveryInput(ctx, repository, args));
}

function workPhase(status: ExecutionJob['status']): 'queued' | 'running' | 'attention' | 'completed' {
  if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) return 'completed';
  if (['orphaned', 'stale', 'human_attention_required'].includes(status)) return 'attention';
  if (status === 'running' || status === 'dispatched') return 'running';
  return 'queued';
}

function summarizeWork(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  const summary = summarizeExecutionJob(job, repoRoot);
  return {
    workId: job.jobId,
    requestId: job.requestId,
    repoId: job.repoId,
    operation: typeof job.payload?.operation === 'string' ? job.payload.operation : job.type,
    phase: workPhase(job.status),
    resumable: true,
    ...summary,
  };
}

function resolveWorkJob(
  ctx: MultiRepositoryMcpToolContext,
  repoId: string,
  args: Record<string, unknown>,
): ExecutionJob | undefined {
  const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!workId && !requestId) throw new Error('WORK_ID_REQUIRED: provide work_id or request_id');
  if (workId) {
    try { return getExecutionJob(ctx.controllerHome, repoId, workId); }
    catch { return undefined; }
  }
  return getExecutionJobByRequestId(ctx.controllerHome, requestId, repoId);
}

export async function callRuntimeTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'work_submit': {
        const repository = selected(ctx, args);
        const requestId = String(args.request_id ?? '').trim();
        const operation = String(args.operation ?? '').trim();
        if (!requestId) throw new Error('REQUEST_ID_REQUIRED: work_submit requires request_id');
        if (!operation || operation.startsWith('work_')) throw new Error('WORK_OPERATION_INVALID: choose an existing durable controller operation');
        const operationArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {};
        const existingRequest = getExecutionJobByRequestId(ctx.controllerHome, requestId);
        if (existingRequest && existingRequest.repoId !== repository.repoId) {
          throw new Error(`REQUEST_ID_REPO_CONFLICT: ${requestId} already belongs to repository ${existingRequest.repoId}`);
        }
        const routed = await routeDurableMcpCall(ctx, operation, {
          ...operationArgs,
          repo_id: repository.repoId,
          request_id: requestId,
          ...(typeof args.timeout_ms === 'number' ? { timeout_ms: args.timeout_ms } : {}),
        });
        if (!routed?.structuredContent || routed.isError) {
          throw new Error(`WORK_OPERATION_NOT_DURABLE: ${operation} is unknown, read-only, or not eligible for durable execution`);
        }
        const accepted = routed.structuredContent as Record<string, unknown>;
        const workId = String(accepted.jobId ?? '').trim();
        const job = workId
          ? getExecutionJob(ctx.controllerHome, repository.repoId, workId)
          : getExecutionJobByRequestId(ctx.controllerHome, requestId, repository.repoId);
        if (!job) throw new Error('WORK_ACCEPTANCE_LOST: durable operation was accepted without a readable Work record');
        return result({ accepted: true, deduplicated: accepted.deduplicated === true, work: summarizeWork(job, repository.canonicalRoot) });
      }
      case 'work_get': {
        const repository = selected(ctx, args);
        const job = resolveWorkJob(ctx, repository.repoId, args);
        if (!job) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.' } }, true);
        return result({
          work: summarizeWork(job, repository.canonicalRoot),
          ...(args.include_events === true ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) } : {}),
        });
      }
      case 'work_list': {
        const repository = selected(ctx, args);
        const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, typeof args.limit === 'number' ? args.limit : 50);
        return result({ works: jobs.map((job) => summarizeWork(job, repository.canonicalRoot)) });
      }
      case 'work_cancel': {
        const repository = selected(ctx, args);
        const job = resolveWorkJob(ctx, repository.repoId, args);
        if (!job) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.' } }, true);
        const cancelled = await cancelExecutionJob(
          ctx.controllerHome,
          repository.repoId,
          job.jobId,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        return result({ work: summarizeWork(cancelled, repository.canonicalRoot) });
      }
      case 'git_diff_paths': {
        const repository = selected(ctx, args);
        return result({
          ...selectedPathDiff(repository, {
            paths: args.paths,
            staged: args.staged === true,
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }),
        });
      }
      case 'git_stage_paths': {
        const repository = selected(ctx, args);
        const staged = stageSelectedPaths(ctx.controllerHome, repository, { paths: args.paths });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...staged,
        }, staged.execution.ok !== true);
      }
      case 'git_commit_paths': {
        const repository = selected(ctx, args);
        const committed = commitSelectedPaths(ctx.controllerHome, repository, {
          paths: args.paths,
          message: args.message,
        });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...committed,
        }, Boolean(committed.error));
      }
      case 'prepare_handoff_artifacts': {
        const repository = selected(ctx, args);
        const handoff = prepareFallbackHandoffArtifacts(repository, { reason: args.reason });
        const taskLedger = writeControllerTaskLedgerArtifacts(repository.canonicalRoot, { reason: args.reason });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...handoff,
          taskLedger: taskLedger.projection,
          artifacts: [
            ...handoff.artifacts,
            ...taskLedger.artifacts,
          ],
        });
      }

      case 'schedule_dedupe_report': {
        const repository = selected(ctx, args);
        return result({ report: buildScheduleDedupeReport(ctx.controllerHome, repository.repoId) });
      }
      case 'schedule_dedupe_apply': {
        const repository = selected(ctx, args);
        return result({ dedupe: applyScheduleDedupe(ctx.controllerHome, repository.repoId, { dryRun: args.dry_run, confirmAuthorization: args.confirm_authorization }) });
      }
      case 'local_bridge_status': {
        const repository = selected(ctx, args);
        const runtime = loadMcpRuntimeState(repository.canonicalRoot);
        const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
        const jobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 12);
        const active = jobs.filter((job) => ['approved', 'running', 'dispatched'].includes(job.status)).length;
        return result({
          endpoint: runtime?.localController?.endpoint ?? inferredLocalBridge?.endpoint ?? 'http://127.0.0.1:8766/',
          running: runtime?.localController?.running ?? inferredLocalBridge?.running ?? false,
          error: runtime?.localController?.error,
          inferredPid: inferredLocalBridge?.pid,
          statusSource: runtime?.localController?.running ? 'runtime-state' : inferredLocalBridge ? 'process-scan' : 'runtime-state',
          counts: jobs.reduce<Record<string, number>>((counts, job) => {
            counts[job.status] = (counts[job.status] ?? 0) + 1;
            return counts;
          }, {}),
          approvalQueue: false,
          reconciliation: { scanned: jobs.length, active, terminalized: 0, deferredToController: true },
          recentJobs: jobs.map((job) => ({
            jobId: job.jobId,
            action: job.action,
            status: job.status,
            checkId: job.action === 'run-check' ? (job.payload as { checkId?: string }).checkId : undefined,
            runId: job.runId,
            issueId: job.issueId,
            taskId: job.taskId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            finishedAt: job.finishedAt,
            revision: job.revision,
            deadlineAt: job.deadlineAt,
            error: job.error?.slice(0, 300),
          })),
          fallback: 'Open the localhost Local Controller to launch work or inspect execution when a ChatGPT write action is unavailable.',
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'get_local_job': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        const job = getLocalBridgeJobSnapshot(repository.canonicalRoot, jobId);
        return result({
          job: job.job,
          lookup: job.status === 'ok' ? undefined : job,
          ...(args.include_events === true && job.status === 'ok'
            ? { events: getLocalBridgeJobEventsSnapshot(repository.canonicalRoot, jobId) }
            : {}),
          ...(args.include_output === true ? { output: readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
            stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }) } : {}),
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'get_local_job_output': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        return result({
          ...readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
            stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
            maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
          }),
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
          nonBlocking: true,
        });
      }
      case 'controller_context_pack': {
        const repository = selected(ctx, args);
        const pack = buildControllerContextPack(repository.canonicalRoot, ctx.policy, {
          description: typeof args.description === 'string' ? args.description : undefined,
          issueId: typeof args.issue_id === 'string' ? args.issue_id : undefined,
          taskId: typeof args.task_id === 'string' ? args.task_id : undefined,
          knownPaths: stringList(args.known_paths),
          includeGlobs: stringList(args.include_globs),
          excludeGlobs: stringList(args.exclude_globs),
          searchTerms: stringList(args.search_terms),
          maxFiles: typeof args.max_files === 'number' ? args.max_files : undefined,
          maxSnippets: typeof args.max_snippets === 'number' ? args.max_snippets : undefined,
          maxCharsPerSnippet: typeof args.max_chars_per_snippet === 'number' ? args.max_chars_per_snippet : undefined,
        });
        return result({
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          contextPack: pack,
        });
      }
      case 'controller_context': {
        const repository = selected(ctx, args);
        const runtimeRoot = repositoryControllerRoot(ctx.controllerHome, repository.repoId);
        const runtimeStorage = {
          repoId: repository.repoId,
          controllerRoot: runtimeRoot,
          readyForExecution: existsSync(runtimeRoot),
          readOnly: true,
        };
        const runtimeSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
        const runtimeProjection = runtimeSnapshot.projection;
        const cached = readControllerContextProjection(ctx.controllerHome, repository.repoId);
        const projectionAgeMs = controllerContextProjectionAgeMs(cached);
        const stale = projectionAgeMs > 10_000;
        const readiness = controllerReadiness(ctx, repository);
        const activeCheckout = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
        const liveGit = gitSnapshot(repository.canonicalRoot);
        const board = projectBoard(repository.canonicalRoot);
        const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
        const currentIssueRecord = board.currentIssueId
          ? board.issues.find((issue) => issue.id === board.currentIssueId)
          : undefined;
        const currentIssue = currentIssueRecord ? {
          id: currentIssueRecord.id,
          title: currentIssueRecord.title,
          status: currentIssueRecord.status,
          lifecycleStatus: currentIssueRecord.lifecycleStatus,
          updatedAt: currentIssueRecord.updatedAt,
          tasks: Array.isArray(currentIssueRecord.tasks)
            ? currentIssueRecord.tasks.slice(0, 20).map((task) => {
              const item = task as Record<string, unknown>;
              return {
                id: item.id,
                title: item.title,
                effectiveStatus: item.effectiveStatus,
                latestRunStatus: item.latestRunStatus,
              };
            })
            : [],
        } : undefined;
        const activeRuns = listActiveAgentJobSnapshots(repository.canonicalRoot, 20).map((run) => ({
          runId: run.runId,
          issueId: run.issueId,
          taskId: run.taskId,
          status: run.status,
          agent: run.agent,
          provider: run.provider,
          executionMode: run.executionMode,
          progress: run.progress,
          lastHeartbeatAt: run.lastHeartbeatAt,
          error: run.error,
        }));
        const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 12);
        const activeLocalJobs = localJobs.filter((job) => ['approved', 'running', 'dispatched'].includes(job.status)).length;
        const recentLocalJobs = localJobs.map((job) => ({
          jobId: job.jobId,
          action: job.action,
          status: job.status,
          runId: job.runId,
          issueId: job.issueId,
          taskId: job.taskId,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          finishedAt: job.finishedAt,
          error: job.error?.slice(0, 300),
        }));
        const checks = listControllerChecks(repository.canonicalRoot).map((check) => ({
          id: check.id,
          description: check.description,
          timeoutMs: check.timeoutMs,
          source: check.source,
        }));
        const plugins = listAssistantPluginManifests(ctx.controllerHome, repository).map((plugin) => ({
          pluginId: plugin.pluginId,
          provider: plugin.provider,
          enabled: plugin.enabled,
          revision: plugin.revision,
          lifecycle: plugin.lifecycle,
          health: plugin.health,
          actions: plugin.actions.map((action) => ({
            actionId: action.actionId,
            readOnly: action.readOnly,
            risk: action.risk,
            confirmation: action.confirmation,
          })),
        }));
        const cachedPayload = cached?.payload ?? {};
        return result({
          ...cachedPayload,
          git: liveGit.branch || liveGit.status || liveGit.diffStat ? liveGit : {
            branch: activeCheckout?.branch ?? null,
            status: 'No live repository scan is available; showing bounded runtime state only.',
            diffStat: '',
            dirty: false,
          },
          currentIssueId: board.currentIssueId,
          currentIssue,
          taskLedger,
          taskLedgerStatus: taskLedger.status,
          readyTasks: board.readyTasks.slice(0, 20),
          activeRuns,
          localBridge: {
            reconciliation: { scanned: localJobs.length, active: activeLocalJobs, terminalized: 0 },
            recentJobs: recentLocalJobs,
          },
          plugins,
          checks,
          repoId: repository.repoId,
          repository: repositorySummary(repository),
          runtimeStorage,
          recommendedExecution: controllerContextAssessment(args),
          runtimeProjection,
          contextProjection: {
            generatedAt: cached?.generatedAt,
            ageMs: Number.isFinite(projectionAgeMs) ? projectionAgeMs : undefined,
            stale,
            strategy: 'event-driven',
            refreshJobId: undefined,
            readOnly: true,
            nonBlocking: true,
          },
          runtimeProjectionState: {
            stale: runtimeSnapshot.stale,
            persisted: runtimeSnapshot.persisted,
          },
          controllerReady: readiness,
        });
      }
      case 'get_job': {
        const jobId = String(args.job_id ?? '').trim();
        const job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
        if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId } }, true);
        const full = args.detail_level === 'full';
        const repoRoot = repositoryRootForRepoId(ctx.controllerHome, job.repoId);
        return result({
          detailLevel: 'summary',
          requestedDetailLevel: full ? 'full' : 'summary',
          job: summarizeExecutionJob(job, repoRoot),
          ...(args.include_events === true
            ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) }
            : {}),
          next: 'Raw job state is intentionally not returned through MCP; use get_artifact for bounded evidence content.',
        });
      }
      case 'get_artifact': {
        const artifactId = String(args.artifact_id ?? '').trim();
        const artifactRepoId = String(args.repo_id ?? '').trim();
        return result(readExecutionArtifact(ctx.controllerHome, artifactRepoId, artifactId, typeof args.max_bytes === 'number' ? args.max_bytes : undefined) as unknown as Record<string, unknown>);
      }
      case 'list_jobs': {
        const repository = selected(ctx, args);
        const requestedLimit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 100;
        const limit = Math.max(1, Math.min(requestedLimit, 100));
        const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, limit);
        const full = args.detail_level === 'full';
        return result({
          detailLevel: 'summary',
          requestedDetailLevel: full ? 'full' : 'summary',
          limit,
          jobs: jobs.map((job) => summarizeExecutionJob(job, repository.canonicalRoot)),
          next: 'Call get_job with one job_id for bounded details; raw job state is intentionally not returned through MCP.',
        });
      }
      case 'cancel_job': {
        const jobId = String(args.job_id ?? '').trim();
        const job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
        if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId } }, true);
        const cancelled = await cancelExecutionJob(ctx.controllerHome, job.repoId, job.jobId, typeof args.reason === 'string' ? args.reason : undefined);
        const repoRoot = repositoryRootForRepoId(ctx.controllerHome, cancelled.repoId);
        return result({ job: summarizeExecutionJob(cancelled, repoRoot) });
      }
      case 'controller_ready': {
        const explicitRepoId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
        const registered = listRepositories(ctx.controllerHome).filter((repository) => repository.enabled && !repository.removedAt);
        const repository = explicitRepoId
          ? selected(ctx, args)
          : (ctx.explicitRepository ?? (registered.length === 1 ? registered[0] : undefined));
        const readiness = controllerReadiness(ctx, repository);
        const taskLedger = repository ? buildControllerTaskLedgerProjection(repository.canonicalRoot) : undefined;
        return result({
          ready: readiness.ready,
          state: readiness.state,
          taskLedgerStatus: taskLedger?.status,
          taskLedgerCounts: taskLedger ? {
            issueCount: taskLedger.issueCount,
            archivedIssueCount: taskLedger.archivedIssueCount,
            effective: taskLedger.counts,
            attention: taskLedger.attention.length,
            ready: taskLedger.readyTasks.length,
            queueable: taskLedger.queueableTasks.length,
          } : undefined,
          gateway: { ready: true, thin: true, longOperationsAreDurable: true },
          daemon: readiness.daemon,
          durableScheduler: readiness.durableScheduler,
          workerLoop: readiness.workerLoop,
          localBridge: readiness.localBridge,
          reasons: readiness.reasons,
          registeredRepositories: registered.length,
          ...(repository ? { repository: summarizeRuntimeProjectionForReadiness(readiness.projection ?? rebuildRepositoryProjection(ctx.controllerHome, repository.repoId)) } : {}),
        });
      }
      case 'repository_runtime_snapshot': {
        const repository = selected(ctx, args);
        return result({ snapshot: summarizeRuntimeProjectionForReadiness(rebuildRepositoryProjection(ctx.controllerHome, repository.repoId)) });
      }
      case 'runtime_performance_diagnostics': {
        const repository = selected(ctx, args);
        const projection = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId).projection;
        const runtime = loadMcpRuntimeState(repository.canonicalRoot);
        const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
        const activeJobIds = listExecutionJobs(ctx.controllerHome, repository.repoId, 100)
          .filter((job) => ['queued', 'dispatched', 'running', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check', 'waiting_for_integration'].includes(job.status))
          .map((job) => job.jobId);
        const diagnostics = collectRuntimePerformanceDiagnostics({
          repoId: repository.repoId,
          repoRoot: repository.canonicalRoot,
          queueDepth: projection?.queueDepth ?? 0,
          runningWorkers: projection?.runningWorkers ?? 0,
          activeLeases: projection?.activeLeases ?? 0,
          activeJobIds,
          includeProcesses: args.include_processes !== false,
          includeTempDirs: args.include_temp_dirs !== false,
          cleanupPreview: args.cleanup_preview === true,
          localControllerRunning: runtime?.localController?.running === true || inferredLocalBridge?.running === true,
          localControllerPid: runtime?.localController?.pid ?? inferredLocalBridge?.pid,
          localControllerEndpoint: runtime?.localController?.endpoint ?? inferredLocalBridge?.endpoint,
        });
        return result({ ...diagnostics });
      }
      case 'capability_recovery_probe': {
        const repository = selected(ctx, args);
        const snapshot = capabilityRecoverySnapshot(ctx, repository, args);
        return result({ recovery: snapshot, audit: listRecoveryAuditRecords(ctx.controllerHome, repository.repoId, 10) });
      }
      case 'capability_recovery_plan': {
        const repository = selected(ctx, args);
        const snapshot = capabilityRecoverySnapshot(ctx, repository, args);
        return result({
          repoId: repository.repoId,
          generatedAt: snapshot.generatedAt,
          overallState: snapshot.overallState,
          fallbackRequired: snapshot.fallbackRequired,
          recommendedActions: snapshot.recommendedActions,
          blockingCapabilities: snapshot.capabilities.filter((capability) => ['blocked', 'unavailable', 'degraded'].includes(capability.state)),
          notes: snapshot.notes,
        });
      }
      case 'runtime_maintenance_status': {
        const repository = selected(ctx, args);
        return result(buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          cancelPendingApprovals: args.cancel_pending_approvals === true,
          recentErrors: Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : undefined,
        }) as unknown as Record<string, unknown>);
      }
      case 'runtime_maintenance_apply': {
        const repository = selected(ctx, args);
        const actionId = String(args.action_id ?? '').trim() as RuntimeMaintenanceActionId;
        if (!actionId) return result({ error: { code: 'RUNTIME_MAINTENANCE_ACTION_REQUIRED', message: 'action_id is required.' } }, true);
        if (args.confirm_maintenance !== true || String(args.authorization ?? '') !== actionId) {
          throw new Error('RUNTIME_MAINTENANCE_AUTHORIZATION_REQUIRED: confirm_maintenance=true and authorization=action_id are required.');
        }
        return result(applyRuntimeMaintenance(repository, ctx.controllerHome, {
          actionId,
          confirmMaintenance: true,
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          cancelPendingApprovals: args.cancel_pending_approvals === true,
        }) as unknown as Record<string, unknown>);
      }
      case 'self_healing_loop_plan': {
        return result(buildSelfHealingLoopPlan({
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          recentErrors: Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : undefined,
          platformBlocked: args.platform_blocked === true,
          sourceDefectSuspected: args.source_defect_suspected === true,
          chatgptAvailable: args.chatgpt_available === undefined ? undefined : args.chatgpt_available === true,
          codexCliAvailable: args.codex_cli_available === true,
          deepseekAvailable: args.deepseek_available === true,
        }) as unknown as Record<string, unknown>);
      }
      case 'self_healing_monitor_tick': {
        const repository = selected(ctx, args);
        const recentErrors = Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : undefined;
        const plugins = listAssistantPluginManifests(ctx.controllerHome, repository);
        const recovery = capabilityRecoverySnapshot(ctx, repository, { ...args, recent_errors: recentErrors });
        const maintenance = buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, { recentErrors });
        const auth = buildWorkspaceAuthStatus(plugins);
        const browserManifest = getAssistantPluginManifest(ctx.controllerHome, repository, 'browser');
        const browserTargets = listWebTargets(repository.canonicalRoot, browserManifest);
        const externalFilesystem = listExternalFilesystemTargets(repository.canonicalRoot);
        const loop = buildSelfHealingLoopPlan({
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          recentErrors,
          platformBlocked: recovery.platformBlocked,
          sourceDefectSuspected: recovery.summary.topRisks.includes('source_defect_suspected'),
          chatgptAvailable: !recovery.platformBlocked,
          codexCliAvailable: false,
          deepseekAvailable: false,
        });
        const browser = {
          ready: browserTargets.length > 0,
          targets: browserTargets,
        };
        const report = buildSelfHealingMonitorReport({
          repoId: repository.repoId,
          mode: args.active_mode === true ? 'active' : 'shadow',
          recovery,
          maintenance,
          auth,
          browser,
          externalFilesystem,
          recentErrors,
        });
        return result({
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          repoId: repository.repoId,
          overallState: recovery.overallState,
          recovery,
          maintenance,
          auth,
          browser: {
            ready: browser.ready,
            targetCount: browser.targets.length,
            targets: browser.targets,
            next: 'Use web_domain_access_preview/apply for new domains; browser submit/payment/upload/download actions remain intentionally unavailable.',
          },
          externalFilesystem,
          loop,
          report,
          candidateFindings: report.candidateFindings,
          nextActions: [
            ...report.nextSteps.map((step) => step.id),
            ...maintenance.recommendedActions.map((action) => `runtime_maintenance_apply:${action}`),
            ...(Array.isArray((auth as { actionRequired?: unknown[] }).actionRequired) && (auth as { actionRequired?: unknown[] }).actionRequired!.length > 0 ? ['workspace_auth_login_prepare'] : []),
            'retry original task only after runtime.storage is ready',
          ],
          safety: {
            mutatesState: false,
            startsJobs: false,
            readsSecrets: false,
            shadowMode: report.mode === 'shadow',
            canAutoModifySource: report.automationPolicy.canAutoModifySource,
          },
        });
      }
      case 'workspace_auth_status': {
        const repository = selected(ctx, args);
        return result(buildWorkspaceAuthStatus(listAssistantPluginManifests(ctx.controllerHome, repository)));
      }
      case 'workspace_auth_login_prepare': {
        selected(ctx, args);
        return result(prepareWorkspaceAuthLogin({
          service: typeof args.service === 'string' ? args.service : undefined,
          scopes: Array.isArray(args.scopes) ? args.scopes.map(String) : undefined,
          redirectUri: typeof args.redirect_uri === 'string' ? args.redirect_uri : undefined,
        }));
      }
      case 'external_filesystem_targets_list': {
        const repository = selected(ctx, args);
        return result(listExternalFilesystemTargets(repository.canonicalRoot));
      }
      case 'external_filesystem_grant_preview': {
        const repository = selected(ctx, args);
        return result(previewExternalFilesystemGrant(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
      }
      case 'external_filesystem_grant_apply': {
        const repository = selected(ctx, args);
        return result(applyExternalFilesystemGrant(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
      }
      case 'external_filesystem_text_snapshot': {
        const repository = selected(ctx, args);
        return result(readExternalFilesystemSnapshot(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
      }
      case 'capability_recovery_apply': {
        const repository = selected(ctx, args);
        const actionId = String(args.action_id ?? '').trim();
        const action = recoveryActionById(actionId);
        if (!action) return result({ error: { code: 'RECOVERY_ACTION_UNKNOWN', message: actionId } }, true);
        assertRecoveryAuthorized(action, action.confirmation === 'none' ? action.id : args.confirm_authorization === true ? String(args.authorization ?? '') : undefined);
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'manual recovery action';
        let payload: Record<string, unknown>;
        let affectedPaths: string[] = [];
        switch (action.id) {
          case 'recovery.probe_again':
            payload = { recovery: capabilityRecoverySnapshot(ctx, repository, args) };
            break;
          case 'recovery.rebuild_projection': {
            const projection = rebuildRepositoryProjection(ctx.controllerHome, repository.repoId);
            payload = { projection };
            affectedPaths = ['.ai/harness/controller/projections'];
            break;
          }
          case 'recovery.refresh_repository': {
            const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
            const projection = rebuildRepositoryProjection(ctx.controllerHome, repository.repoId);
            payload = { runtimeStorage, projection };
            affectedPaths = ['.ai/harness/controller', '.ai/harness/local-bridge'];
            break;
          }
          case 'recovery.cleanup_preview': {
            payload = previewRuntimeCleanup(repository.canonicalRoot, {
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
              includeTempDirs: true,
              includeTerminalLocalJobs: true,
              includeLegacyRuns: true,
              includeHistoricalAttention: true,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            }) as unknown as Record<string, unknown>;
            break;
          }
          case 'recovery.cleanup_apply': {
            payload = applyRuntimeCleanup(repository.canonicalRoot, {
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
              includeTempDirs: true,
              includeTerminalLocalJobs: true,
              includeLegacyRuns: true,
              includeHistoricalAttention: true,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
              confirmCleanup: true,
            }) as unknown as Record<string, unknown>;
            affectedPaths = ['.ai/harness/local-jobs-archive', '.ai/harness/jobs-archive', '.ai/harness/controller/acknowledged-attention.jsonl'];
            break;
          }
          case 'recovery.reconcile_jobs':
          case 'recovery.local_jobs_reconcile': {
            const maintenance = applyRuntimeMaintenance(repository, ctx.controllerHome, {
              actionId: 'local_jobs_reconcile',
              confirmMaintenance: true,
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : 10,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            });
            payload = { maintenance };
            affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/local-jobs-quarantine', '.ai/harness/controller'];
            break;
          }
          case 'recovery.local_jobs_quarantine_unreadable': {
            const maintenance = applyRuntimeMaintenance(repository, ctx.controllerHome, {
              actionId: 'quarantine_unreadable_local_jobs',
              confirmMaintenance: true,
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : 0,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            });
            payload = { maintenance };
            affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/local-jobs-quarantine'];
            break;
          }
          case 'recovery.runtime_storage_finalize_relocation': {
            const maintenance = applyRuntimeMaintenance(repository, ctx.controllerHome, {
              actionId: 'runtime_storage_finalize_relocation',
              confirmMaintenance: true,
              minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : 0,
              maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
            });
            payload = { maintenance };
            affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/controller'];
            break;
          }
          case 'recovery.restart_controller': {
            const daemon = ensureControllerDaemon(ctx.controllerHome);
            payload = { daemon, note: 'ensureControllerDaemon starts or verifies the bounded repo-harness daemon; it does not kill unrelated processes.' };
            affectedPaths = ['_ops/controller-home/daemon'];
            break;
          }
          case 'recovery.restart_local_bridge':
            payload = { skipped: true, reason: 'Local bridge restart must be performed by the owning supervisor process or CLI to avoid killing the current HTTP request mid-response.' };
            break;
          case 'recovery.create_patch_handoff':
            payload = prepareFallbackHandoffArtifacts(repository, { reason }) as unknown as Record<string, unknown>;
            affectedPaths = ['.ai/handoff'];
            break;
          case 'recovery.workspace_auth_login_prepare':
            payload = { skipped: true, nextTool: 'workspace_auth_login_prepare', reason: 'Auth login is a non-secret handoff and should be prepared through the dedicated typed tool.' };
            break;
          case 'recovery.browser_domain_access_preview':
            payload = { skipped: true, nextTool: 'web_domain_access_preview', reason: 'Browser access must be granted by domain key before snapshot or interaction.' };
            break;
          case 'recovery.external_filesystem_grant_preview':
            payload = { skipped: true, nextTool: 'external_filesystem_grant_preview', reason: 'External filesystem access must be converted into a named read-only target first.' };
            break;
          case 'recovery.create_self_fix_task':
            payload = { skipped: true, next: 'Create an isolated Issue/Task or Campaign for source repair; automatic source-fix dispatch remains gated by existing execution policies.' };
            break;
          default:
            payload = { skipped: true, reason: `No executor is registered for ${action.id}.` };
        }
        const audit = writeRecoveryAuditRecord(ctx.controllerHome, repository.repoId, buildRecoveryAuditRecord({
          actor: 'capability_recovery_apply',
          action,
          result: payload.skipped === true ? 'skipped' : 'succeeded',
          reason,
          affectedPaths,
        }));
        return result({ repoId: repository.repoId, action, audit, result: payload });
      }
      case 'runtime_storage_repair_preview': {
        const repository = selected(ctx, args);
        const preview = previewRuntimeStorageRepair(repository, ctx.controllerHome, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        });
        return result({ ...preview });
      }
      case 'runtime_storage_repair_apply': {
        const repository = selected(ctx, args);
        const candidateIds = Array.isArray(args.candidate_ids) ? args.candidate_ids.map(String) : undefined;
        const applied = applyRuntimeStorageRepair(repository, ctx.controllerHome, {
          candidateIds,
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          confirmRepair: args.confirm_repair === true,
        });
        const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
        const projection = rebuildRepositoryProjection(ctx.controllerHome, repository.repoId);
        return result({ ...applied, runtimeStorage, projection });
      }
      case 'list_plugins': {
        const repository = selected(ctx, args);
        return result({ plugins: listAssistantPluginManifests(ctx.controllerHome, repository).map(summarizePlugin) });
      }
      case 'get_plugin': {
        const repository = selected(ctx, args);
        return result({ plugin: summarizePlugin(getAssistantPluginManifest(ctx.controllerHome, repository, String(args.plugin_id ?? '').trim())) });
      }
      case 'assistant_readiness': {
        const repository = selected(ctx, args);
        const readiness = buildAssistantReadinessReport(ctx.controllerHome, repository);
        return result({ ...readiness });
      }

      case 'gmail_triage_rules': {
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, path: '.repo-harness/assistant/gmail-triage-rules.json', ...readGmailTriageRules(repository) });
      }
      case 'gmail_triage_rule_upsert': {
        const repository = selected(ctx, args);
        const upserted = upsertGmailTriageRule(repository, args);
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...upserted });
      }
      case 'gmail_triage_plan': {
        const repository = selected(ctx, args);
        let manifest;
        try { manifest = getAssistantPluginManifest(ctx.controllerHome, repository, 'gmail'); } catch (_error) { manifest = undefined; }
        return result(buildGmailTriagePlan(repository, { manifest, items: args.items, query: args.query }) as unknown as Record<string, unknown>);
      }
      case 'review_artifacts_prepare': {
        const repository = selected(ctx, args);
        return result(ensureReviewArtifactRoots(repository));
      }
      case 'review_artifacts_index': {
        const repository = selected(ctx, args);
        return result(buildReviewArtifactIndex(repository, { limit: args.limit }) as unknown as Record<string, unknown>);
      }
      case 'browser_review_packet': {
        const repository = selected(ctx, args);
        return result(prepareBrowserReviewPacket(repository, { limit: args.limit }) as unknown as Record<string, unknown>);
      }
      case 'ios_review_packet': {
        const repository = selected(ctx, args);
        return result(prepareIosReviewPacket(repository, { udid: args.udid, label: args.label, capture: args.capture, limit: args.limit }) as unknown as Record<string, unknown>);
      }
      case 'workflow_watchdog_report': {
        const repository = selected(ctx, args);
        return result(buildWorkflowWatchdogReport(ctx.controllerHome, repository, { staleMinutes: args.stale_minutes, includeProcesses: args.include_processes }) as unknown as Record<string, unknown>);
      }
      case 'ios_xcode_status': {
        return result({ ...iosXcodeStatus() });
      }
      case 'ios_simulators_list': {
        return result({ ...iosSimulatorsList({
          runtime: typeof args.runtime === 'string' ? args.runtime : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
        }) });
      }
      case 'ios_project_discover': {
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, ...iosProjectDiscover(repository) });
      }
      case 'ios_schemes_list': {
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, ...iosSchemesList(repository, {
          workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
          project: typeof args.project === 'string' ? args.project : undefined,
        }) });
      }
      case 'ios_simulator_boot': {
        if (args.confirm_authorization !== true) throw new Error('IOS_AUTHORIZATION_REQUIRED: confirm_authorization must be true');
        return result({ ...iosSimulatorBoot({
          udid: String(args.udid ?? '').trim(),
          openSimulator: args.open_simulator !== false,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        }) });
      }
      case 'ios_app_build': {
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, ...iosAppBuild(repository, {
          scheme: String(args.scheme ?? '').trim(),
          udid: typeof args.udid === 'string' ? args.udid : undefined,
          simulatorName: typeof args.simulator_name === 'string' ? args.simulator_name : undefined,
          workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
          project: typeof args.project === 'string' ? args.project : undefined,
          configuration: typeof args.configuration === 'string' ? args.configuration : undefined,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        }) });
      }
      case 'ios_app_install': {
        if (args.confirm_authorization !== true) throw new Error('IOS_AUTHORIZATION_REQUIRED: confirm_authorization must be true');
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, ...iosAppInstall(repository, {
          udid: String(args.udid ?? '').trim(),
          appPath: String(args.app_path ?? '').trim(),
        }) });
      }
      case 'ios_app_launch': {
        if (args.confirm_authorization !== true) throw new Error('IOS_AUTHORIZATION_REQUIRED: confirm_authorization must be true');
        return result({ ...iosAppLaunch({
          udid: String(args.udid ?? '').trim(),
          bundleId: String(args.bundle_id ?? '').trim(),
          arguments: Array.isArray(args.arguments) ? args.arguments.map(String) : undefined,
        }) });
      }
      case 'ios_simulator_screenshot': {
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, ...iosSimulatorScreenshot(repository, {
          udid: String(args.udid ?? '').trim(),
          label: typeof args.label === 'string' ? args.label : undefined,
        }) });
      }
      case 'ios_simulator_log_tail': {
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, ...iosSimulatorLogTail(repository, {
          udid: String(args.udid ?? '').trim(),
          process: typeof args.process === 'string' ? args.process : undefined,
          last: typeof args.last === 'string' ? args.last : undefined,
          maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
        }) });
      }
      case 'ios_ui_smoke_test': {
        if (args.confirm_authorization !== true) throw new Error('IOS_AUTHORIZATION_REQUIRED: confirm_authorization must be true');
        const repository = selected(ctx, args);
        return result({ repoId: repository.repoId, ...iosUiSmokeTest(repository, {
          udid: typeof args.udid === 'string' ? args.udid : undefined,
          simulatorName: typeof args.simulator_name === 'string' ? args.simulator_name : undefined,
          scheme: typeof args.scheme === 'string' ? args.scheme : undefined,
          bundleId: typeof args.bundle_id === 'string' ? args.bundle_id : undefined,
          workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
          project: typeof args.project === 'string' ? args.project : undefined,
          configuration: typeof args.configuration === 'string' ? args.configuration : undefined,
          appPath: typeof args.app_path === 'string' ? args.app_path : undefined,
          screenshotLabel: typeof args.screenshot_label === 'string' ? args.screenshot_label : undefined,
        }) });
      }
      case 'runtime_cleanup_preview': {
        const repository = selected(ctx, args);
        const preview = previewRuntimeCleanup(repository.canonicalRoot, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          includeTempDirs: args.include_temp_dirs !== false,
          includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
          includeLegacyRuns: args.include_legacy_runs === true,
          includeHistoricalAttention: args.include_historical_attention === true,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        });
        return result({ ...preview });
      }
      case 'runtime_cleanup_apply': {
        const repository = selected(ctx, args);
        const applied = applyRuntimeCleanup(repository.canonicalRoot, {
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          includeTempDirs: args.include_temp_dirs !== false,
          includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
          includeLegacyRuns: args.include_legacy_runs === true,
          includeHistoricalAttention: args.include_historical_attention === true,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          confirmCleanup: args.confirm_cleanup === true,
        });
        return result({ ...applied });
      }
      case 'plugin_action_execute': {
        const repository = selected(ctx, args);
        const submitted = submitAssistantPluginAction(ctx.controllerHome, repository, {
          pluginId: String(args.plugin_id ?? '').trim(),
          actionId: String(args.action_id ?? '').trim(),
          requestId: String(args.request_id ?? '').trim(),
          args: args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
            ? args.arguments as Record<string, unknown>
            : {},
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
          origin: { surface: 'mcp', actor: 'plugin_action_execute', correlationId: String(args.request_id ?? '').trim() },
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({
          accepted: true,
          deduplicated: submitted.deduplicated,
          plugin: summarizePlugin(submitted.manifest),
          action: {
            actionId: submitted.action.actionId,
            risk: submitted.action.risk,
            confirmation: submitted.action.confirmation,
            requiredConfirmationText: submitted.action.requiredConfirmationText,
          },
          job: summarizeWork(submitted.job, repository.canonicalRoot),
          daemon: { status: daemon.status, pid: daemon.pid },
          next: `Call get_job with job_id ${submitted.job.jobId}.`,
        });
      }
      case 'toolchain_plugin_summary': {
        const repository = selected(ctx, args);
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, String(args.plugin_id ?? '').trim());
        return result({
          plugin: summarizePluginForLowInterception(manifest),
          nonOpaque: true,
          next: manifest.pluginId === 'browser'
            ? 'Use web_targets_list, web_domain_access_preview, or web_target_snapshot instead of raw browser action names.'
            : undefined,
        });
      }
      case 'web_targets_list': {
        const repository = selected(ctx, args);
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, 'browser');
        return result({
          pluginId: 'browser',
          enabled: manifest.enabled,
          healthState: manifest.health.state,
          ready: manifest.health.ready,
          targets: listWebTargets(repository.canonicalRoot, manifest),
          safety: {
            arbitraryUrlAccepted: false,
            returnsRawConfig: false,
            nextTool: 'web_target_snapshot',
          },
        });
      }
      case 'web_target_snapshot': {
        const repository = selected(ctx, args);
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, 'browser');
        const url = resolveWebTargetUrl(repository.canonicalRoot, String(args.target_key ?? '').trim(), args.path, args.query, manifest);
        const capture = args.capture === 'screenshot' ? 'screenshot' : args.capture === 'text' ? 'text' : 'title';
        const actionId = capture === 'screenshot' ? 'screenshot' : 'open_page';
        const actionArguments: Record<string, unknown> = {
          url,
          wait_until: typeof args.wait_until === 'string' ? args.wait_until : 'domcontentloaded',
          timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          ...(capture === 'text' ? { extract_text: true, max_chars: typeof args.max_chars === 'number' ? args.max_chars : 4000 } : {}),
          ...(capture === 'screenshot' ? { full_page: args.full_page === true } : {}),
        };
        const requestId = String(args.request_id ?? '').trim();
        if (!requestId) throw new Error('REQUEST_ID_REQUIRED: web_target_snapshot requires request_id');
        const submitted = submitAssistantPluginAction(ctx.controllerHome, repository, {
          pluginId: 'browser',
          actionId,
          requestId,
          args: actionArguments,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          origin: { surface: 'mcp', actor: 'web_target_snapshot', correlationId: requestId },
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({
          accepted: true,
          deduplicated: submitted.deduplicated,
          webTarget: {
            targetKey: String(args.target_key ?? '').trim(),
            capture,
            path: typeof args.path === 'string' ? args.path : '/',
            arbitraryUrlAccepted: false,
          },
          job: summarizeWork(submitted.job, repository.canonicalRoot),
          daemon: { status: daemon.status, pid: daemon.pid },
          next: `Call work_status_digest with work_ref ${submitted.job.jobId}.`,
        });
      }
      case 'web_domain_access_preview': {
        const repository = selected(ctx, args);
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, 'browser');
        return result({
          preview: previewBrowserDomainAccess(repository.canonicalRoot, args.domain, args.reason, manifest),
          next: 'After human review, call web_domain_access_apply with confirm_authorization=true.',
        });
      }
      case 'web_domain_access_apply': {
        const repository = selected(ctx, args);
        if (args.confirm_authorization !== true) throw new Error('CONFIRM_AUTHORIZATION_REQUIRED: web_domain_access_apply requires confirm_authorization=true');
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, 'browser');
        const preview = previewBrowserDomainAccess(repository.canonicalRoot, args.domain, args.reason, manifest);
        const providedTicket = typeof args.preview_ticket_id === 'string' ? args.preview_ticket_id.trim() : '';
        if (providedTicket && providedTicket !== preview.ticketId) throw new Error('DOMAIN_ACCESS_TICKET_MISMATCH');
        const requestId = String(args.request_id ?? '').trim();
        if (!requestId) throw new Error('REQUEST_ID_REQUIRED: web_domain_access_apply requires request_id');
        const allowedDomains = mergeAllowedDomains(repository.canonicalRoot, args.domain, manifest);
        const submitted = submitAssistantPluginAction(ctx.controllerHome, repository, {
          pluginId: 'browser',
          actionId: 'configure',
          requestId,
          args: { enabled: true, allowed_domains: allowedDomains },
          confirmAuthorization: true,
          origin: { surface: 'mcp', actor: 'web_domain_access_apply', correlationId: requestId },
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({
          accepted: true,
          deduplicated: submitted.deduplicated,
          preview,
          allowedDomainCount: allowedDomains.length,
          job: summarizeWork(submitted.job, repository.canonicalRoot),
          daemon: { status: daemon.status, pid: daemon.pid },
          next: `Call work_status_digest with work_ref ${submitted.job.jobId}.`,
        });
      }
      case 'work_result_summary': {
        const repository = selected(ctx, args);
        const jobId = String(args.job_id ?? '').trim();
        const job = getExecutionJob(ctx.controllerHome, repository.repoId, jobId);
        const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
        return result({
          summary: summarizeJobResultForLowInterception(job),
          taskLedgerStatus: taskLedger.status,
          next: taskLedger.status.nextAction,
        });
      }
      case 'work_status_digest': {
        const repository = selected(ctx, args);
        const workRef = String(args.work_ref ?? '').trim();
        const job = getExecutionJob(ctx.controllerHome, repository.repoId, workRef);
        const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
        return result({
          digest: summarizeJobResultForLowInterception(job),
          workRef,
          taskLedgerStatus: taskLedger.status,
          next: taskLedger.status.nextAction,
        });
      }
      case 'model_clients_summary': {
        return result({ clients: buildModelClientSummary(), policyOwner: 'repo-harness', transportEncryption: 'not-configured-by-this-tool' });
      }
      case 'model_control_plane_summary': {
        return result({ controlPlane: buildModelControlPlaneSummary(), transportEncryption: 'not-configured-by-this-tool' });
      }
      case 'deepseek_tool_manifest': {
        return result({ provider: 'deepseek', tools: deepSeekFunctionToolManifest(), policyOwner: 'repo-harness' });
      }
      case 'deepseek_tool_call_prepare': {
        const functionArguments = args.function_arguments && typeof args.function_arguments === 'object' && !Array.isArray(args.function_arguments)
          ? args.function_arguments as Record<string, unknown>
          : {};
        return result({ prepared: prepareDeepSeekToolCall(String(args.function_name ?? '').trim(), functionArguments) });
      }
      case 'deepseek_controller_manifest': {
        return result({ manifest: deepSeekControllerManifest() });
      }
      case 'deepseek_controller_handoff_prepare': {
        const repository = selected(ctx, args);
        return result({ handoff: prepareDeepSeekControllerHandoff({
          reason: args.reason as never,
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          repoId: repository.repoId,
          currentController: typeof args.current_controller === 'string' ? args.current_controller : undefined,
          blockedToolName: typeof args.blocked_tool_name === 'string' ? args.blocked_tool_name : undefined,
          recentSafeError: typeof args.recent_safe_error === 'string' ? args.recent_safe_error : undefined,
        }) });
      }
      case 'deepseek_controller_request_prepare': {
        const repository = selected(ctx, args);
        return result({ preview: prepareDeepSeekControllerRequest({
          reason: args.reason as never,
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          userMessage: typeof args.user_message === 'string' ? args.user_message : undefined,
          repoId: repository.repoId,
          currentController: typeof args.current_controller === 'string' ? args.current_controller : undefined,
          blockedToolName: typeof args.blocked_tool_name === 'string' ? args.blocked_tool_name : undefined,
          recentSafeError: typeof args.recent_safe_error === 'string' ? args.recent_safe_error : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
        }) });
      }
      case 'create_campaign': {
        const repository = selected(ctx, args);
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const requestId = String(args.request_id ?? '').trim();
        const title = String(args.title ?? '').trim();
        const goal = String(args.goal ?? '').trim();
        if (!requestId) throw new Error('CAMPAIGN_REQUEST_ID_REQUIRED');
        if (!title) throw new Error('CAMPAIGN_TITLE_REQUIRED');
        if (!goal) throw new Error('CAMPAIGN_GOAL_REQUIRED');
        const budget = args.budget && typeof args.budget === 'object' && !Array.isArray(args.budget)
          ? args.budget as Record<string, unknown>
          : {};
        const budgetInput = {
          maxParallelTasks: typeof budget.max_parallel_tasks === 'number' ? budget.max_parallel_tasks : undefined,
          maxExecutionJobs: typeof budget.max_execution_jobs === 'number' ? budget.max_execution_jobs : undefined,
          maxSupervisorReviews: typeof budget.max_supervisor_reviews === 'number' ? budget.max_supervisor_reviews : undefined,
          defaultTaskMaxAttempts: typeof budget.default_task_max_attempts === 'number' ? budget.default_task_max_attempts : undefined,
          taskTimeoutMs: typeof budget.task_timeout_ms === 'number' ? budget.task_timeout_ms : undefined,
          retryBaseDelayMs: typeof budget.retry_base_delay_ms === 'number' ? budget.retry_base_delay_ms : undefined,
          retryMaxDelayMs: typeof budget.retry_max_delay_ms === 'number' ? budget.retry_max_delay_ms : undefined,
          reviewPacketMaxBytes: typeof budget.review_packet_max_bytes === 'number' ? budget.review_packet_max_bytes : undefined,
        };
        // Validate task shape, DAG, and governance before creating any Git refs or worktrees.
        const sourceTasks = rawTasks.map((task) => campaignTaskInput(task, repository.repoId, repository.activeCheckoutId));
        validateCreateCampaignTasks(sourceTasks, budgetInput);
        const workspaceInput = args.workspace && typeof args.workspace === 'object' && !Array.isArray(args.workspace)
          ? args.workspace as Record<string, unknown>
          : {};
        const workspaceMode = workspaceInput.mode === 'current' ? 'current' : 'isolated';
        const workspace = workspaceMode === 'current'
          ? currentCampaignWorkspace(repository)
          : ensureCampaignWorkspace(ctx.controllerHome, repository, {
            requestId,
            title,
            baseRef: typeof workspaceInput.base_ref === 'string'
              ? workspaceInput.base_ref
              : typeof workspaceInput.baseRef === 'string' ? workspaceInput.baseRef : undefined,
            branchName: typeof workspaceInput.branch_name === 'string'
              ? workspaceInput.branch_name
              : typeof workspaceInput.branchName === 'string' ? workspaceInput.branchName : undefined,
          });
        const campaignCheckoutId = workspace.checkoutId ?? repository.activeCheckoutId;
        const supervisor = args.supervisor && typeof args.supervisor === 'object' && !Array.isArray(args.supervisor)
          ? args.supervisor as Record<string, unknown>
          : {};
        const supervisorMode = supervisor.mode === 'operation'
          ? 'operation'
          : supervisor.mode === 'workspace_agent' ? 'workspace_agent' : 'pull';
        const supervisorOperation = typeof supervisor.operation === 'string' && supervisor.operation.trim()
          ? assertCampaignOperationSupported(supervisor.operation)
          : undefined;
        const workspaceAgentId = typeof supervisor.workspace_agent_id === 'string'
          ? supervisor.workspace_agent_id.trim()
          : typeof supervisor.workspaceAgentId === 'string' ? supervisor.workspaceAgentId.trim() : undefined;
        const conversationKey = typeof supervisor.conversation_key === 'string'
          ? supervisor.conversation_key.trim()
          : typeof supervisor.conversationKey === 'string' ? supervisor.conversationKey.trim() : undefined;
        const supervisorArguments = supervisor.arguments && typeof supervisor.arguments === 'object' && !Array.isArray(supervisor.arguments)
          ? supervisor.arguments as Record<string, unknown>
          : undefined;
        if (supervisorOperation) {
          if (CAMPAIGN_CONTROL_OPERATIONS.has(supervisorOperation)) throw new Error(`CAMPAIGN_RECURSIVE_OPERATION_DENIED: ${supervisorOperation}`);
          assertAutomatedOperationAllowed(supervisorOperation, supervisorArguments ?? {});
        }
        const campaign = createCampaign(ctx.controllerHome, {
          repoId: repository.repoId,
          checkoutId: campaignCheckoutId,
          workspace,
          requestId,
          semanticKey: typeof args.semantic_key === 'string' && args.semantic_key.trim()
            ? args.semantic_key.trim()
            : `campaign:${repository.repoId}:${createHash('sha256').update(`${String(args.title ?? '')}:${String(args.goal ?? '')}`).digest('hex').slice(0, 20)}`,
          title,
          goal,
          acceptanceCriteria: stringList(args.acceptance_criteria),
          nonGoals: stringList(args.non_goals),
          reviewPolicy: ['every_task', 'failures_and_final', 'final_only'].includes(String(args.review_policy))
            ? String(args.review_policy) as CampaignReviewPolicy
            : 'every_task',
          tasks: rawTasks.map((task) => campaignTaskInput(task, repository.repoId, campaignCheckoutId)),
          budget: budgetInput,
          supervisor: {
            mode: supervisorMode,
            operation: supervisorMode === 'operation' ? supervisorOperation : undefined,
            workspaceAgentId: supervisorMode === 'workspace_agent' ? workspaceAgentId : undefined,
            conversationKey: supervisorMode === 'workspace_agent' ? conversationKey : undefined,
            arguments: supervisorMode === 'operation' ? supervisorArguments : undefined,
            priority: ['P0', 'P1', 'P2', 'P3', 'P4'].includes(String(supervisor.priority)) ? String(supervisor.priority) as 'P0' | 'P1' | 'P2' | 'P3' | 'P4' : undefined,
            resourceClaims: supervisorMode === 'operation' && supervisorOperation
              ? claimsForMcpOperation(supervisorOperation, supervisorArguments ?? {}, repository.repoId, campaignCheckoutId)
              : undefined,
            triggerCooldownMs: typeof supervisor.trigger_cooldown_ms === 'number' ? supervisor.trigger_cooldown_ms : undefined,
            maxTriggerAttempts: typeof supervisor.max_trigger_attempts === 'number' ? supervisor.max_trigger_attempts : undefined,
            decisionTimeoutMs: typeof supervisor.decision_timeout_ms === 'number' ? supervisor.decision_timeout_ms : undefined,
          },
          createdBy: 'chatgpt',
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({ ...campaign, daemon: { status: daemon.status, pid: daemon.pid }, next: 'Use get_campaign_review_packet when the campaign opens a checkpoint.' });
      }
      case 'list_campaigns': {
        const repository = selected(ctx, args);
        return result({ campaigns: listCampaigns(ctx.controllerHome, repository.repoId, typeof args.limit === 'number' ? args.limit : 100) });
      }
      case 'get_campaign': {
        const repository = selected(ctx, args);
        return result({ campaign: getCampaign(ctx.controllerHome, repository.repoId, String(args.campaign_id ?? '')) });
      }
      case 'add_campaign_task': {
        const repository = selected(ctx, args);
        const campaignId = String(args.campaign_id ?? '');
        const existingCampaign = getCampaign(ctx.controllerHome, repository.repoId, campaignId);
        const campaign = addCampaignTask(
          ctx.controllerHome,
          repository.repoId,
          campaignId,
          String(args.request_id ?? ''),
          campaignTaskInput(args.task, repository.repoId, existingCampaign.checkoutId),
          expectedRevision(args),
        );
        ensureControllerDaemon(ctx.controllerHome);
        return result({ campaign });
      }
      case 'pause_campaign': {
        const repository = selected(ctx, args);
        return result({ campaign: setCampaignStatus(ctx.controllerHome, repository.repoId, String(args.campaign_id ?? ''), String(args.request_id ?? ''), 'paused', typeof args.reason === 'string' ? args.reason : undefined, expectedRevision(args)) });
      }
      case 'resume_campaign': {
        const repository = selected(ctx, args);
        const campaign = setCampaignStatus(ctx.controllerHome, repository.repoId, String(args.campaign_id ?? ''), String(args.request_id ?? ''), 'active', undefined, expectedRevision(args));
        ensureControllerDaemon(ctx.controllerHome);
        return result({ campaign });
      }
      case 'cancel_campaign': {
        const repository = selected(ctx, args);
        return result({ campaign: await cancelCampaign(ctx.controllerHome, repository.repoId, String(args.campaign_id ?? ''), String(args.request_id ?? ''), typeof args.reason === 'string' ? args.reason : undefined, expectedRevision(args)) });
      }
      case 'get_campaign_review_packet': {
        const repository = selected(ctx, args);
        const campaign = getCampaign(ctx.controllerHome, repository.repoId, String(args.campaign_id ?? ''));
        const checkpointId = typeof args.checkpoint_id === 'string' && args.checkpoint_id.trim()
          ? args.checkpoint_id.trim()
          : campaign.checkpoints.filter((checkpoint) => checkpoint.status === 'open').at(-1)?.checkpointId;
        if (!checkpointId) throw new Error('CAMPAIGN_OPEN_CHECKPOINT_NOT_FOUND');
        const checkpoint = campaign.checkpoints.find((entry) => entry.checkpointId === checkpointId);
        if (!checkpoint || checkpoint.status !== 'open') throw new Error(`CAMPAIGN_OPEN_CHECKPOINT_NOT_FOUND: ${checkpointId}`);
        return result({ campaignId: campaign.campaignId, campaignRevision: campaign.revision, checkpoint: { ...checkpoint, packet: checkpoint.packet } });
      }
      case 'submit_campaign_review': {
        const repository = selected(ctx, args);
        const revised = args.revised_goal && typeof args.revised_goal === 'object' && !Array.isArray(args.revised_goal)
          ? args.revised_goal as Record<string, unknown>
          : undefined;
        const campaign = submitCampaignReview(ctx.controllerHome, {
          repoId: repository.repoId,
          campaignId: String(args.campaign_id ?? ''),
          checkpointId: String(args.checkpoint_id ?? ''),
          nonce: String(args.checkpoint_nonce ?? ''),
          goalRevision: Number(args.goal_revision),
          expectedCampaignRevision: expectedRevision(args, 'expected_campaign_revision'),
          requestId: String(args.request_id ?? ''),
          decision: {
            action: String(args.action ?? '') as CampaignSupervisorAction,
            summary: String(args.summary ?? ''),
            instructions: typeof args.instructions === 'string' ? args.instructions : undefined,
            revisedGoal: revised ? {
              statement: String(revised.statement ?? ''),
              acceptanceCriteria: stringList(revised.acceptance_criteria),
              nonGoals: stringList(revised.non_goals),
              reason: typeof revised.reason === 'string' ? revised.reason : undefined,
            } : undefined,
            submittedBy: typeof args.submitted_by === 'string' ? args.submitted_by : 'chatgpt',
          },
        });
        ensureControllerDaemon(ctx.controllerHome);
        return result({ campaign });
      }
      case 'accept_campaign': {
        const repository = selected(ctx, args);
        const current = getCampaign(ctx.controllerHome, repository.repoId, String(args.campaign_id ?? ''));
        if (current.status !== 'ready_for_human_acceptance') throw new Error(`CAMPAIGN_NOT_READY_FOR_ACCEPTANCE: ${current.status}`);
        return result({ campaign: setCampaignStatus(ctx.controllerHome, repository.repoId, current.campaignId, String(args.request_id ?? ''), 'completed', 'Accepted by human.', expectedRevision(args)) });
      }
      case 'reconcile_campaign': {
        const repository = selected(ctx, args);
        const reconciliation = reconcileCampaign(ctx.controllerHome, repository.repoId, String(args.campaign_id ?? ''));
        ensureControllerDaemon(ctx.controllerHome);
        return result({ reconciliation, campaign: getCampaign(ctx.controllerHome, repository.repoId, reconciliation.campaignId) });
      }
      case 'create_schedule': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? '').trim();
        const operationArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments as Record<string, unknown> : {};
        assertAutomatedOperationAllowed(operation, operationArgs);
        const scheduleRequestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `schedule:auto:${repository.repoId}:${createHash('sha256').update(JSON.stringify({ name: args.name, operation, arguments: operationArgs, everyMinutes: args.every_minutes })).digest('hex').slice(0, 20)}:${Math.floor(Date.now() / (5 * 60_000))}`;
        const schedule = createSchedule(ctx.controllerHome, {
          requestId: scheduleRequestId,
          repoId: repository.repoId,
          name: String(args.name ?? '').trim(),
          enabled: true,
          trigger: {
            type: ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'].includes(String(args.trigger_type))
              ? String(args.trigger_type) as 'interval' | 'cron' | 'calendar' | 'condition' | 'repository-event' | 'dependency-checkpoint' | 'manual'
              : typeof args.every_minutes === 'number' ? 'interval' : 'manual',
            everyMinutes: typeof args.every_minutes === 'number' ? Math.max(1, args.every_minutes) : undefined,
            cronExpression: typeof args.cron_expression === 'string' ? args.cron_expression : undefined,
            calendarAt: typeof args.calendar_at === 'string' ? args.calendar_at : undefined,
            condition: args.condition && typeof args.condition === 'object' ? args.condition as never : undefined,
            eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
            dependencyJobIds: Array.isArray(args.dependency_job_ids) ? args.dependency_job_ids.map(String) : undefined,
          },
          policy: {
            maxActiveOccurrences: 1,
            maxFailures: typeof args.max_failures === 'number' ? Math.max(1, args.max_failures) : 3,
            cooldownMinutes: typeof args.cooldown_minutes === 'number' ? Math.max(0, args.cooldown_minutes) : 120,
            dailyBudgetMinutes: typeof args.daily_budget_minutes === 'number' ? Math.max(1, args.daily_budget_minutes) : 180,
            shadowMode: args.shadow_mode !== false,
            backoffBaseMinutes: typeof args.backoff_base_minutes === 'number' ? Math.max(1, args.backoff_base_minutes) : 5,
            backoffMaxMinutes: typeof args.backoff_max_minutes === 'number' ? Math.max(1, args.backoff_max_minutes) : 24 * 60,
          },
          action: { operation, arguments: operationArgs, resourceClaims: claimsForMcpOperation(operation, operationArgs, repository.repoId, repository.activeCheckoutId) },
          stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : ['release_ready', 'external_blocker', 'human_review_required'],
        });
        return result({ schedule });
      }
      case 'list_schedules': {
        const repository = selected(ctx, args);
        const schedules = listSchedules(ctx.controllerHome, repository.repoId);
        if (args.include_occurrences !== true) return result({ schedules });
        const occurrences = listOccurrences(ctx.controllerHome, repository.repoId, undefined, 100);
        const decisions = occurrences.flatMap((occurrence) => occurrence.decisionId
          ? [getScheduleDecision(ctx.controllerHome, repository.repoId, occurrence.decisionId)].filter(Boolean)
          : []);
        return result({ schedules, occurrences, decisions });
      }
      case 'pause_schedule': {
        const repository = selected(ctx, args);
        const schedule = getSchedule(ctx.controllerHome, repository.repoId, String(args.schedule_id ?? ''));
        return result({ schedule: saveSchedule(ctx.controllerHome, { ...schedule, enabled: false, pausedReason: typeof args.reason === 'string' ? args.reason : 'Paused by user.' }) });
      }
      case 'trigger_schedule': {
        const repository = selected(ctx, args);
        const schedule = getSchedule(ctx.controllerHome, repository.repoId, String(args.schedule_id ?? ''));
        const occurrence = await evaluateSchedule(ctx.controllerHome, schedule, true, {
          source: typeof args.event_name === 'string' ? 'repository-event' : 'manual',
          eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
          eventId: typeof args.event_id === 'string' ? args.event_id : undefined,
          data: args.event_data && typeof args.event_data === 'object' ? args.event_data as Record<string, unknown> : undefined,
        });
        ensureControllerDaemon(ctx.controllerHome);
        return result({ occurrence });
      }
      case 'request_release_gate': {
        const repository = selected(ctx, args);
        const requestId = typeof args.request_id === 'string' && args.request_id.trim() ? args.request_id.trim() : `release:${repository.repoId}:${Math.floor(Date.now() / 60_000)}`;
        const created = createExecutionJob(ctx.controllerHome, {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          type: 'release-gate',
          requestId,
          semanticKey: `release-gate:${repository.repoId}`,
          origin: { surface: 'mcp', actor: 'request_release_gate' },
          payload: { operation: 'release-gate', target: 'runtime' },
          priority: 'P1',
          resourceClaims: [{ resourceKey: `release:${repository.repoId}`, mode: 'exclusive' }],
          timeoutMs: 15 * 60_000,
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({ accepted: true, jobId: created.job.jobId, status: created.job.status, deduplicated: created.deduplicated, daemon, next: `Call get_job with ${created.job.jobId}.` });
      }
      case 'create_portfolio_workflow': {
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        const workflow = createPortfolioWorkflow(ctx.controllerHome, {
          name: String(args.name ?? '').trim(),
          requestId: String(args.request_id ?? '').trim(),
          failurePolicy: args.failure_policy === 'compensate' ? 'compensate' : 'stop',
          steps: rawSteps.map((raw, index) => {
            if (!raw || typeof raw !== 'object') throw new Error(`PORTFOLIO_STEP_INVALID: step ${index + 1}`);
            const step = raw as Record<string, unknown>;
            const stepRepoId = String(step.repo_id ?? '').trim();
            const operation = String(step.operation ?? '').trim();
            const operationArgs = step.arguments && typeof step.arguments === 'object' ? step.arguments as Record<string, unknown> : {};
            if (!stepRepoId || !operation) throw new Error(`PORTFOLIO_STEP_INVALID: step ${index + 1} requires repo_id and operation`);
            assertAutomatedOperationAllowed(operation, operationArgs);
            const checkoutId = resolveRepositorySelection({ repoId: stepRepoId, controllerHome: ctx.controllerHome, allowSoleRepository: false }).activeCheckoutId;
            const compensation = step.compensation && typeof step.compensation === 'object'
              ? step.compensation as Record<string, unknown>
              : undefined;
            if (compensation) {
              const compensationOperation = String(compensation.operation ?? '').trim();
              const compensationArguments = compensation.arguments && typeof compensation.arguments === 'object'
                ? compensation.arguments as Record<string, unknown>
                : {};
              assertAutomatedOperationAllowed(compensationOperation, compensationArguments);
            }
            return {
              stepId: String(step.step_id ?? `step-${index + 1}`),
              repoId: stepRepoId,
              operation,
              arguments: operationArgs,
              dependsOn: Array.isArray(step.depends_on) ? step.depends_on.map(String) : [],
              priority: ['P0', 'P1', 'P2', 'P3', 'P4'].includes(String(step.priority)) ? String(step.priority) as 'P0' | 'P1' | 'P2' | 'P3' | 'P4' : 'P2',
              resourceClaims: claimsForMcpOperation(operation, operationArgs, stepRepoId, checkoutId),
              compensation: compensation ? { operation: String(compensation.operation ?? ''), arguments: compensation.arguments && typeof compensation.arguments === 'object' ? compensation.arguments as Record<string, unknown> : undefined } : undefined,
              status: 'pending' as const,
            };
          }),
        });
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({ workflow, daemon: { status: daemon.status, pid: daemon.pid } });
      }
      case 'list_portfolio_workflows':
        return result({ workflows: listPortfolioWorkflows(ctx.controllerHome, typeof args.limit === 'number' ? args.limit : 100) });
      case 'get_portfolio_workflow':
        return result({ workflow: getPortfolioWorkflow(ctx.controllerHome, String(args.workflow_id ?? '')) });
      case 'record_candidate_finding': {
        const repository = selected(ctx, args);
        const semanticKey = String(args.semantic_key ?? '').trim();
        const requestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `candidate:${repository.repoId}:${createHash('sha256').update(semanticKey).digest('hex').slice(0, 20)}:${Math.floor(Date.now() / (5 * 60_000))}`;
        const finding = recordCandidateFinding(ctx.controllerHome, {
          repoId: repository.repoId,
          requestId,
          semanticKey,
          title: String(args.title ?? '').trim(),
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          severity: ['low', 'medium', 'high', 'critical'].includes(String(args.severity))
            ? String(args.severity) as 'low' | 'medium' | 'high' | 'critical'
            : 'medium',
          evidence: {
            source: 'mcp',
            reference: typeof args.reference === 'string' ? args.reference : undefined,
            details: args.evidence && typeof args.evidence === 'object' ? args.evidence as Record<string, unknown> : undefined,
          },
        });
        return result({ finding });
      }
      case 'list_candidate_findings': {
        const repository = selected(ctx, args);
        return result({ findings: listCandidateFindings(ctx.controllerHome, repository.repoId, {
          includeTerminal: args.include_terminal === true,
          limit: typeof args.limit === 'number' ? args.limit : 100,
        }) });
      }
      case 'promote_candidate_finding': {
        const repository = selected(ctx, args);
        const finding = getCandidateFinding(ctx.controllerHome, repository.repoId, String(args.finding_id ?? ''));
        if (finding.promotedJobId) {
          const existing = findExecutionJob(ctx.controllerHome, finding.promotedJobId);
          if (existing && !['failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(existing.status)) {
            return result({ accepted: true, finding, jobId: finding.promotedJobId, status: existing.status, deduplicated: true });
          }
          if (existing?.status === 'succeeded' && finding.status === 'promoted') {
            return result({ accepted: true, finding, jobId: finding.promotedJobId, status: existing.status, deduplicated: true });
          }
        }
        const requestId = typeof args.request_id === 'string' && args.request_id.trim()
          ? args.request_id.trim()
          : `candidate-promotion:${repository.repoId}:${finding.findingId}`;
        const created = createExecutionJob(ctx.controllerHome, {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          type: 'mcp-tool',
          requestId,
          semanticKey: `candidate-promotion:${finding.findingId}:${finding.semanticKey}`,
          origin: { surface: 'mcp', actor: 'promote_candidate_finding', correlationId: finding.findingId },
          payload: {
            operation: 'create_issue',
            target: 'mcp-tool',
            profile: ctx.policy.profile,
            arguments: {
              title: finding.title,
              summary: finding.summary,
              kind: typeof args.kind === 'string' ? args.kind : 'investigation',
              goals: Array.isArray(args.goals) ? args.goals.map(String) : [],
              acceptance_criteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : [],
              related_artifacts: finding.evidence.map((entry) => entry.reference).filter((value): value is string => Boolean(value)),
            },
          },
          priority: finding.severity === 'critical' ? 'P0' : finding.severity === 'high' ? 'P1' : 'P2',
          resourceClaims: [{ resourceKey: 'repo-state', mode: 'write' }],
          maxAttempts: 1,
        });
        const promoted = updateCandidateFinding(ctx.controllerHome, repository.repoId, finding.findingId, (current) => ({
          ...current,
          status: 'candidate',
          promotedJobId: created.job.jobId,
        }), requestId, 'candidate_promotion_requested');
        const daemon = ensureControllerDaemon(ctx.controllerHome);
        return result({ accepted: true, finding: promoted, jobId: created.job.jobId, status: created.job.status, deduplicated: created.deduplicated, daemon, next: `Call get_job with ${created.job.jobId}.` });
      }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result({ error: { code: message.includes(':') ? message.split(':', 1)[0] : 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
