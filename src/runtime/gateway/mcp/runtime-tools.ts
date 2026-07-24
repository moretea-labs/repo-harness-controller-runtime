import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { collectRuntimePerformanceDiagnostics, inferLocalControllerProcess } from '../../diagnostics/performance';
import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import { listRepositories, repositorySummary, resolveRepositorySelection } from '../../../cli/repositories/registry';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { cancelExecutionJob, createExecutionJob, findExecutionJob, getExecutionJob, getExecutionJobByRequestId, listExecutionJobs } from '../../execution/jobs/store';
import { waitForExecutionJob } from '../../execution/jobs/wait';
import type { ExecutionJob } from '../../execution/jobs/types';
import { getProcessHandle, waitForProcess } from '../../execution/process-runtime';
import { buildJobOperationDigest } from '../../control-plane/facade/operation-digest';
import { readJobEvents } from '../../evidence/event-ledger';
import { readExecutionArtifact } from '../../evidence/artifact-store';
import { readExecutionEvidence } from '../../evidence/evidence-store';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../control-plane/daemon-client';
import { readSchedulerHealthSnapshot } from '../../control-plane/global-scheduler/scheduler';
import {
  evaluateActiveRuntimeSourceDrift,
  formatRuntimeSourceDriftMessage,
  type RuntimeSourceIdentity,
} from '../../control-plane/runtime-generation';
import { rebuildRepositoryProjection, projectionObservation, readRepositoryProjectionSnapshot } from '../../projections/materialized-view';
import {
  buildRuntimeOperationalView,
  evaluateRuntimeHealth,
  RUNTIME_HEALTH_THRESHOLDS,
  type RuntimeHealthEvaluation,
  type RuntimeOperationalView,
} from '../../health';
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
import { cancelCampaign, completeCampaignWorkspace } from '../../workflow/campaigns/cleanup';
import {
  assertCampaignOperationSupported,
  normalizeCampaignDependencyReferences,
} from '../../workflow/campaigns/normalize';
import { ensureRepositoryRuntimeStorage } from '../../../cli/repositories/runtime-storage';
import { assessWorkMode } from '../../../cli/controller/work-mode';
import { scheduleControllerServiceRestart } from '../../../cli/controller/restart-coordinator';
import { stableSupervisorFacadeMutation, stableSupervisorFacadeOperation, stableSupervisorFacadeStatus } from '../../supervisor/facade';
import { readSupervisorState } from '../../supervisor/state-store';
import { isStableSupervisorInstalled } from '../../supervisor/paths';
import { readSupervisorServiceReleaseCoherence } from '../../supervisor/release-coherence';
import type { SupervisorOperationKind } from '../../supervisor/types';
import { projectBoard } from '../../../cli/controller/issue-store';
import {
  buildControllerTaskLedgerProjection,
  writeControllerTaskLedgerArtifacts,
} from '../../../cli/controller/task-ledger';
import { buildControllerContextPack } from '../../../cli/controller/context-pack';
import { buildControllerOperationalPlan } from '../../../cli/controller/operational-plan';
import { listControllerChecks, runControllerCheck } from '../../../cli/controller/check-runner';
import {
  controllerFeatureVerify,
  controllerRestartVerify,
  repositoryChangeVerify,
} from '../../../cli/controller/composite-operations';
import { controllerRollback, controllerRollout } from '../../../cli/controller/bluegreen-rollout';
import { listActiveAgentJobSnapshots } from '../../../cli/agent-jobs/job-manager';
import { readAgentExecutableReadinessSnapshot } from '../../../cli/agent-jobs/executable-resolver';
import {
  commitSelectedPaths,
  prepareFallbackHandoffArtifacts,
  selectedPathDiff,
  stageSelectedPaths,
} from '../../../cli/repositories/selected-path-actions';
import type { TaskRisk } from '../../../cli/controller/types';
import {
  controllerContextProjectionAgeMs,
  controllerContextProjectionNeedsRefresh,
  readControllerContextProjection,
  writeControllerContextProjection,
} from '../../projections/controller-context';
import { loadMcpRuntimeState } from '../../../cli/mcp/auth';
import { isExpectedLocalControllerHealth } from '../../../cli/mcp/keepalive';
import { readActiveSlotAuthority } from '../../../cli/controller/runtime-slots';
import { resolveStableControllerHome } from '../../../cli/controller/stable-state/stable-home';
import { redactMcpText } from '../../../cli/mcp/redaction';
import { resolveLocalBridgeSurface, summarizeRecentJobs } from '../../shared/local-bridge-surface';
import { controllerPluginRepository, executeAssistantPluginReadDirect, getAssistantPluginManifest, isDirectPluginReadAction, listAssistantPluginManifests, submitAssistantPluginAction } from '../../plugins/store';
import {
  listWebTargets,
  mergeAllowedDomains,
  previewBrowserDomainAccess,
  resolveWebTargetUrl,
  summarizeExecutionJobForMcp,
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
import { approveAssistantActionProposal, getAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from '../../assistant/action-proposals';
import { assistantModelReadiness } from '../../assistant/model-provider';
import { createAssistantStandingGrant, listAssistantStandingGrants, revokeAssistantStandingGrant } from '../../assistant/standing-grants';
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
import {
  acknowledgeHandoffItem,
  allowedFacadeOperations,
  buildFacadeResult,
  classifyVerificationOutcome,
  createHandoffItem,
  dismissHandoffItem,
  getHandoffItem,
  listCapabilityDescriptors,
  summarizeCapabilityGroups,
  listHandoffItems,
  normalizeCheckIds,
  resolveHandoffItem,
  runGoalWorkloop,
  runSelfHealingLoop,
  delegateToCodexCerebellum,
  summarizeHandoffItem,
  listWorkContracts,
  getWorkContract,
  verifyGoalWorkloop,
  type FacadeTool,
} from '../../control-plane/facade';
import {
  executorDispatch,
  executorRoutePreview,
  goalContinue,
  goalCreate,
  goalFinalize,
  goalGet,
  goalHandoffPacketCreate,
  goalHandoffPacketGet,
  goalList,
  goalStart,
  goalStatus,
  goalStop,
  goalTickOnce,
  providerConfigStatusAction,
  providerHealthAction,
  providerListAction,
  repairContinue,
  repairPlan,
  summarizeGoalContract,
  tickActiveGoals,
  type GoalContract,
  type GoalLoopContext,
  type GoalStatus,
  type TaskIntent,
} from '../../control-plane/goal-loop';

function summarizeGoalPublic(goal: GoalContract) {
  return summarizeGoalContract(goal);
}

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
  definition('rh_status', 'Preferred ChatGPT facade: bounded controller status, capability readiness, and self-healing diagnose/repair.', {
    repo_id: repoId,
    operation: { type: 'string', enum: ['list', 'get', 'repair', 'runtime_status', 'runtime_operation_get'], description: 'Defaults to get.' },
    detail_level: { type: 'string', enum: ['summary', 'detail'], description: 'Defaults to summary.' },
    repair_operation: { type: 'string', enum: ['diagnose', 'repair', 'verify', 'handoff'] },
    dry_run: { type: 'boolean', description: 'Defaults to true for repair/diagnose.' },
    approval_confirmed: { type: 'boolean' },
    chatgpt_pull_failed: { type: 'boolean' },
    destructive: { type: 'boolean' },
    process_kill_or_restart: { type: 'boolean' },
    operation_id: { type: 'string', description: 'Stable Supervisor operation ID for runtime_operation_get.' },
  }),
  definition('rh_inbox', 'Preferred ChatGPT facade: pending handoff decisions only (not logs).', {
    repo_id: repoId,
    operation: { type: 'string', enum: ['list', 'get', 'ack', 'resolve', 'dismiss', 'create'], description: 'Defaults to list (pending).' },
    handoff_id: { type: 'string' },
    work_id: { type: 'string' },
    title: { type: 'string' },
    reason: { type: 'string' },
    summary: { type: 'string' },
    recommended_decision: { type: 'string' },
    recommended_prompt: { type: 'string' },
    decision: { type: 'string', description: 'Recorded on resolve/dismiss.' },
    resolver: { type: 'string', description: 'Who resolved or dismissed the handoff.' },
    detail_level: { type: 'string', enum: ['summary', 'detail'] },
    limit: { type: 'number' },
  }),
  definition('rh_context', 'Preferred ChatGPT facade: bounded repository context, checks, capabilities, and work contract summary.', {
    repo_id: repoId,
    operation: { type: 'string', enum: ['list', 'get'], description: 'Defaults to get.' },
    requested_check_ids: { type: 'array', items: { type: 'string' } },
    work_id: { type: 'string' },
    detail_level: { type: 'string', enum: ['summary', 'detail', 'raw'], description: 'Defaults to summary; raw is still bounded.' },
  }),
  definition('rh_work', 'Preferred ChatGPT facade: direct control, goal workloop, verify, finalize, stop, repair, and small-brain delegate (codex/grok/claude).', {
    repo_id: repoId,
    operation: { type: 'string', enum: ['start', 'continue', 'verify', 'repair', 'finalize', 'stop', 'delegate', 'runtime_status', 'runtime_operation_get', 'runtime_restart_controller', 'runtime_restart_gateway', 'runtime_restart_full', 'runtime_rollout', 'runtime_rollback', 'runtime_unlock_and_recover'], description: 'Defaults to start.' },
    objective: { type: 'string' },
    work_id: { type: 'string' },
    expected_files: { type: 'number' },
    expected_changed_lines: { type: 'number' },
    scope_clear: { type: 'boolean' },
    requires_investigation: { type: 'boolean' },
    requires_long_running_checks: { type: 'boolean' },
    requires_parallelism: { type: 'boolean' },
    needs_dependencies: { type: 'boolean' },
    requires_recovery: { type: 'boolean' },
    requires_worker: { type: 'boolean', description: 'Opt-in only. Set true only when the user explicitly requests Codex/Claude or another agent worker; never infer it from task complexity.' },
    requires_external_effect: { type: 'boolean' },
    requires_approval: { type: 'boolean' },
    requires_user_approval: { type: 'boolean' },
    destructive: { type: 'boolean' },
    remote_write: { type: 'boolean' },
    secret_access: { type: 'boolean' },
    capability_id: { type: 'string' },
    approval_confirmed: { type: 'boolean' },
    dry_run: { type: 'boolean', description: 'Defaults to true for repair.' },
    check_ids: { type: 'array', items: { type: 'string' } },
    check_id: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    allowed_paths: { type: 'array', items: { type: 'string' } },
    forbidden_paths: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'object' },
    repair_operation: { type: 'string', enum: ['diagnose', 'repair', 'verify', 'handoff'] },
    target: { type: 'string', enum: ['codex', 'grok', 'claude'], description: 'Explicit small-brain delegate target for operation=delegate. Delegation is never the default execution path.' },
    available: { type: 'boolean', description: 'Whether the delegate target is currently available.' },
    codex_available: { type: 'boolean' },
    simulate_check: { type: 'boolean', description: 'Test hook: skip real check execution and use infrastructure_failed/check_failed flags.' },
    infrastructure_failed: { type: 'boolean' },
    check_failed: { type: 'boolean' },
    authorize_destructive_cleanup: { type: 'boolean' },
    detail_level: { type: 'string', enum: ['summary', 'detail'] },
    request_id: { type: 'string', description: 'Stable idempotency key for runtime operations.' },
    operation_id: { type: 'string', description: 'Stable Supervisor operation ID.' },
    reason: { type: 'string', description: 'Bounded reason for a runtime operation.' },
  }, [], false),
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
    wait: { type: 'boolean', description: 'When true, wait for terminal status before returning digest.' },
    wait_ms: { type: 'number' },
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
  definition('work_wait', 'Wait for one Work/ExecutionJob/managed process to reach a terminal status and return a bounded operation digest.', {
    repo_id: repoId,
    work_id: { type: 'string' },
    request_id: { type: 'string' },
    wait_ms: { type: 'number', description: 'Max wait in ms. Default 15000, max 120000.' },
  }),
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
    wait: { type: 'boolean', description: 'When true, wait for terminal status before returning digest.' },
    wait_ms: { type: 'number' },
  }, ['job_id']),
  definition('get_artifact', 'Read one bounded Evidence Plane artifact by id. Large content remains bounded.', { artifact_id: { type: 'string' }, repo_id: repoId, max_bytes: { type: 'number' } }, ['artifact_id', 'repo_id']),
  definition('repository_change_verify', 'Composite: verify checkout/SHA, apply bounded patch, run checks, return first failure inline without get_job/get_artifact follow-ups.', {
    repo_id: repoId,
    expected_branch: { type: 'string' },
    expected_head: { type: 'string' },
    expected_file_shas: { type: 'object', additionalProperties: { type: 'string' } },
    patch: { type: 'string', description: 'Unified diff applied with git apply.' },
    allowed_paths: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    check_timeout_ms: { type: 'number' },
  }, [], false),
  definition('controller_restart_verify', 'Composite: durable controller restart with full health verification; resume the same requestId instead of resubmitting.', {
    repo_id: repoId,
    request_id: { type: 'string' },
    reason: { type: 'string' },
    poll_only: { type: 'boolean' },
    mode: { type: 'string', enum: ['auto', 'sync', 'detached'] },
    expected_source_commit: { type: 'string' },
    expected_tool_fingerprint: { type: 'string' },
  }, [], false),
  definition('controller_feature_verify', 'Composite: feature-branch unit + isolated lifecycle gate for green rollout readiness. Does not push.', {
    repo_id: repoId,
    skip_lifecycle: { type: 'boolean' },
  }, [], false),
  definition('controller_rollout', 'Blue/green rollout through the single lifecycle surface: start inactive slot, verify, atomic cutover.', {
    repo_id: repoId,
    skip_durable_job: { type: 'boolean' },
    reason: { type: 'string' },
  }, [], false),
  definition('controller_rollback', 'Rollback to the previous healthy runtime slot within the bounded window.', {
    repo_id: repoId,
    skip_durable_job: { type: 'boolean' },
  }, [], false),
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
  definition('goal_create', 'Create a durable GoalContract (objective-level loop state above Issue/Task).', {
    repo_id: repoId,
    title: { type: 'string' },
    objective: { type: 'string' },
    mode: { type: 'string', enum: ['manual', 'supervised', 'autonomous'] },
    issue_id: { type: 'string' },
    task_ids: { type: 'array', items: { type: 'string' } },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    check_ids: { type: 'array', items: { type: 'string' } },
    allowed_executors: { type: 'array', items: { type: 'string' } },
    forbidden_executors: { type: 'array', items: { type: 'string' } },
    retry_budget: { type: 'number' },
  }, ['title', 'objective'], false),
  definition('goal_list', 'List GoalContracts for a repository.', {
    repo_id: repoId,
    status: { type: 'string', enum: ['active', 'all', 'created', 'planning', 'ready', 'dispatching', 'running', 'verifying', 'repairing', 'waiting_for_user', 'handoff_ready', 'finalized', 'failed', 'stopped'] },
    limit: { type: 'number' },
  }),
  definition('goal_get', 'Get one GoalContract by id.', {
    repo_id: repoId,
    goal_id: { type: 'string' },
  }, ['goal_id']),
  definition('goal_start', 'Start a GoalContract (created -> planning) or tick if already active.', {
    repo_id: repoId,
    goal_id: { type: 'string' },
  }, ['goal_id'], false),
  definition('goal_continue', 'Advance a GoalContract by one bounded daemon-style transition.', {
    repo_id: repoId,
    goal_id: { type: 'string' },
  }, ['goal_id'], false),
  definition('goal_stop', 'Stop a GoalContract.', {
    repo_id: repoId,
    goal_id: { type: 'string' },
    reason: { type: 'string' },
  }, ['goal_id'], false),
  definition('goal_finalize', 'Finalize a GoalContract when verification evidence exists.', {
    repo_id: repoId,
    goal_id: { type: 'string' },
    force: { type: 'boolean' },
  }, ['goal_id'], false),
  definition('goal_status', 'User-facing goal loop status (active goals, stage, provider health, handoff).', {
    repo_id: repoId,
    goal_id: { type: 'string' },
  }),
  definition('goal_tick_once', 'Daemon-owned single tick for one goal (or all active goals when goal_id omitted).', {
    repo_id: repoId,
    goal_id: { type: 'string' },
    task_intent: { type: 'string', enum: ['deterministic_edit', 'code_implementation', 'code_repair', 'architecture_planning', 'ios_build_or_sim', 'browser_automation', 'verification_repair', 'review', 'unknown'] },
    verification_ok: { type: 'boolean' },
    verification_check_id: { type: 'string' },
    provider_failure: { type: 'boolean' },
    external_write: { type: 'boolean' },
    approval_confirmed: { type: 'boolean' },
  }, [], false),
  definition('goal_handoff_packet_create', 'Create a ChatGPT/supervisor continuation packet (handoff-only path).', {
    repo_id: repoId,
    goal_id: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    required_user_decision: { type: 'string' },
    recommended_provider: { type: 'string' },
  }, ['goal_id'], false),
  definition('goal_handoff_packet_get', 'Read a durable goal handoff/continuation packet.', {
    repo_id: repoId,
    packet_id: { type: 'string' },
  }, ['packet_id']),
  definition('provider_list', 'List model/code executor providers (invokable vs handoff-only).', {
    repo_id: repoId,
  }),
  definition('provider_health', 'Bounded redacted provider health (never returns tokens).', {
    repo_id: repoId,
    provider_id: { type: 'string' },
  }),
  definition('provider_config_status', 'Summarize invokable vs missing_auth vs handoff-only providers.', {
    repo_id: repoId,
  }),
  definition('executor_route_preview', 'Preview which provider the ExecutorRouter would select.', {
    repo_id: repoId,
    goal_id: { type: 'string' },
    task_intent: { type: 'string', enum: ['deterministic_edit', 'code_implementation', 'code_repair', 'architecture_planning', 'ios_build_or_sim', 'browser_automation', 'verification_repair', 'review', 'unknown'] },
    risk: { type: 'string', enum: ['readonly', 'local_repo_write', 'workspace_write', 'remote_write', 'destructive', 'raw_secret_config'] },
    objective: { type: 'string' },
  }),
  definition('executor_dispatch', 'Policy-gated dispatch to an invokable provider; repo-harness applies/verifies patches (no raw shell exposure).', {
    repo_id: repoId,
    goal_id: { type: 'string' },
    provider_id: { type: 'string' },
    task_intent: { type: 'string', enum: ['deterministic_edit', 'code_implementation', 'code_repair', 'architecture_planning', 'ios_build_or_sim', 'browser_automation', 'verification_repair', 'review', 'unknown'] },
    risk: { type: 'string', enum: ['readonly', 'local_repo_write', 'workspace_write', 'remote_write', 'destructive', 'raw_secret_config'] },
    approval_confirmed: { type: 'boolean' },
    external_write: { type: 'boolean' },
    strong_confirmation_text: { type: 'string' },
  }, ['goal_id'], false),
  definition('repair_plan', 'Classify goal failure and recommend repair provider/status.', {
    repo_id: repoId,
    goal_id: { type: 'string' },
  }, ['goal_id']),
  definition('repair_continue', 'Continue the self-healing repair loop for a goal (one bounded transition).', {
    repo_id: repoId,
    goal_id: { type: 'string' },
    force_failure_class: { type: 'string' },
  }, ['goal_id'], false),
  definition('workspace_auth_status', 'Summarize Workspace/Gmail auth readiness without returning or persisting secrets.', {
    repo_id: repoId,
  }),
  definition('workspace_auth_login_prepare', 'Prepare a state-protected local Google Workspace/Gmail OAuth login with PKCE and Keychain persistence.', {
    repo_id: repoId,
    service: { type: 'string', enum: ['gmail', 'calendar', 'tasks', 'google-workspace'] },
    scopes: { type: 'array', items: { type: 'string' } },
    redirect_uri: { type: 'string' },
  }),
  definition('assistant_model_readiness', 'Read the optional bounded Assistant model provider configuration without returning secrets.', {
    repo_id: repoId,
  }),
  definition('assistant_standing_grants', 'List scoped, expiring Assistant Standing Grants.', {
    repo_id: repoId,
    status: { type: 'string', enum: ['active', 'revoked', 'expired'] },
    limit: { type: 'number' },
  }),
  definition('assistant_standing_grant_create', 'Create an explicitly authorized Standing Grant for a hardcoded low-risk action.', {
    repo_id: repoId,
    name: { type: 'string' },
    plugin_id: { type: 'string' },
    action_id: { type: 'string' },
    routine_ids: { type: 'array', items: { type: 'string' } },
    sender_allowlist: { type: 'array', items: { type: 'string' } },
    subject_contains: { type: 'array', items: { type: 'string' } },
    min_confidence: { type: 'number' },
    max_per_run: { type: 'number' },
    expires_in_days: { type: 'number' },
    confirm_authorization: { type: 'boolean' },
  }, ['plugin_id', 'action_id', 'confirm_authorization'], false),
  definition('assistant_standing_grant_revoke', 'Revoke a Standing Grant with explicit authorization.', {
    repo_id: repoId,
    grant_id: { type: 'string' },
    reason: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
  }, ['grant_id', 'confirm_authorization'], false),
  definition('assistant_action_proposals', 'List or get structured Assistant action proposals and execution status.', {
    repo_id: repoId,
    proposal_id: { type: 'string' },
    status: { type: 'string', enum: ['proposed', 'approved', 'rejected', 'executed', 'failed', 'expired'] },
    limit: { type: 'number' },
  }),
  definition('assistant_action_proposal_resolve', 'Approve or reject one Assistant action proposal. Approval submits a separate user-authorized plugin Job.', {
    repo_id: repoId,
    proposal_id: { type: 'string' },
    decision: { type: 'string', enum: ['approve', 'reject'] },
    request_id: { type: 'string' },
    reason: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
    confirmation_text: { type: 'string' },
  }, ['proposal_id', 'decision'], false),
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
  definition('list_plugins', 'List repository plugins, or controller-scoped plugins when repo_id is omitted.', {
    repo_id: repoId,
  }),
  definition('get_plugin', 'Read one repository or controller-scoped plugin manifest including action schemas and policy requirements.', {
    repo_id: repoId,
    plugin_id: { type: 'string' },
  }, ['plugin_id']),
  definition('plugin_action_execute', 'Submit one typed repository or controller-scoped plugin action through the durable execution layer.', {
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
  // Compact text channel by default (no pretty-print bloat).
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
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
  return summarizeExecutionJobForMcp(job, repoRoot);
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
    requiresIndependentDeliverables: args.requires_independent_deliverables === true,
    independentTaskCount: typeof args.independent_task_count === 'number' ? args.independent_task_count : undefined,
    requiresRemoteWrite: args.requires_remote_write === true || args.remote_write === true,
    requiresRecovery: args.requires_recovery === true,
    agentRequested: args.agent_requested === true || args.requires_worker === true,
    requiresWorkerIsolation: args.requires_worker_isolation === true,
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

const CONTROLLER_CONTEXT_PROJECTION_REFRESH_MS = 5_000;

function ageMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : undefined;
}

async function probeLocalControllerHealth(endpoint: string | undefined): Promise<Record<string, unknown> | null> {
  if (!endpoint) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const url = new URL(endpoint);
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function controllerReadiness(ctx: MultiRepositoryMcpToolContext, repository = ctx.explicitRepository) {
  const daemon = readControllerDaemonStatus(ctx.controllerHome);
  const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
  const projectionSnapshot = repository ? readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId) : undefined;
  const projection = projectionSnapshot?.projection;
  const localBridgeSurface = repository
    ? resolveLocalBridgeSurface({
      controllerHome: ctx.controllerHome,
      repoRoot: repository.canonicalRoot,
      allowProcessScan: false,
    })
    : undefined;
  const localBridgeEndpoint = localBridgeSurface?.endpoint;
  const shouldProbeLocalBridge = Boolean(
    localBridgeSurface?.enabled
    && localBridgeSurface.endpointConfigured
    && localBridgeEndpoint
    && localBridgeSurface.mode !== 'disabled',
  );
  const localBridgeLiveHealth = shouldProbeLocalBridge
    ? await probeLocalControllerHealth(localBridgeEndpoint)
    : null;
  const localBridgeEndpointReachable = localBridgeLiveHealth !== null;
  const localBridgeExpectedSurface = shouldProbeLocalBridge
    ? isExpectedLocalControllerHealth(localBridgeLiveHealth, {
      repoRoot: repository?.canonicalRoot,
      generation: localBridgeSurface?.generation,
    })
    : true;
  const expectedActiveSlot = localBridgeSurface?.activeSlot
    ?? readActiveSlotAuthority(ctx.controllerHome).activeSlot;
  const observedSlot = localBridgeLiveHealth?.slot === 'blue' || localBridgeLiveHealth?.slot === 'green'
    ? localBridgeLiveHealth.slot
    : undefined;
  const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
  const dispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
  const localBridgeObservation = {
    enabled: localBridgeSurface?.enabled ?? false,
    requiredForReadiness: localBridgeSurface?.requiredForReadiness ?? false,
    mode: localBridgeSurface?.mode ?? ('disabled' as const),
    endpoint: localBridgeEndpoint,
    endpointReachable: shouldProbeLocalBridge ? localBridgeEndpointReachable : true,
    expectedSurface: localBridgeExpectedSurface,
    activeSlot: observedSlot ? observedSlot === expectedActiveSlot : undefined,
    generationMatches: localBridgeSurface?.generation && localBridgeLiveHealth?.generation
      ? localBridgeLiveHealth.generation === localBridgeSurface.generation
      : undefined,
    processAlive: localBridgeSurface?.processRunning,
    runtimeStateFresh: localBridgeSurface?.source === 'service-runtime'
      || localBridgeSurface?.source === 'repo-runtime',
    error: localBridgeSurface?.error,
  };
  const runtimeHealth = evaluateRuntimeHealth({
    daemon: {
      status: daemon.status,
      error: daemon.error,
      // Scheduler ticks are emitted by the Controller Daemon process and provide
      // its continuously refreshed heartbeat without introducing a second timer.
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
    },
    scheduler: {
      status: daemon.degraded ? 'degraded' : daemon.status,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs,
    },
    workers: {
      queueDepth: projection?.queueDepth,
      runningWorkers: projection?.runningWorkers,
      activeLeases: projection?.activeLeases,
      activeAttentionCount: projection?.currentAttention.length,
    },
    projection: projectionSnapshot ? projectionObservation(projectionSnapshot) : {
      readable: true,
      persisted: true,
    },
    localBridge: localBridgeObservation,
    runtimeStorage: { readable: true, ready: true },
  });
  const operationalView: RuntimeOperationalView = buildRuntimeOperationalView({
    health: runtimeHealth,
    handoffs: repository
      ? listHandoffItems({ controllerHome: ctx.controllerHome, repoId: repository.repoId, status: 'all', limit: 100 })
      : [],
    jobs: repository ? listExecutionJobs(ctx.controllerHome, repository.repoId, 100) : [],
  });
  const reasons: Array<{ code: string; message: string }> = runtimeHealth.activeBlockers.map((item) => ({
    code: item.code === 'SCHEDULER_NOT_PROGRESSING'
      ? 'DISPATCH_LOOP_STALLED'
      : item.code === 'LEASE_WITHOUT_WORKER' || item.code === 'WORKER_NOT_RUNNING'
        ? 'WORKER_NOT_RUNNING'
        : item.code,
    message: item.message,
  }));
  if (
    reasons.some((item) => item.code === 'WORKER_NOT_RUNNING')
    && (dispatchHeartbeatAgeMs === undefined || dispatchHeartbeatAgeMs > RUNTIME_HEALTH_THRESHOLDS.queueProgressStaleMs)
  ) {
    reasons.push({
      code: 'QUEUE_NOT_PROGRESSING',
      message: 'Queued Jobs have not received a recent dispatch heartbeat.',
    });
  }
  const ready = runtimeHealth.ready;
  return {
    ready,
    state: ready ? runtimeHealth.state === 'healthy' ? 'ready' as const : 'degraded' as const : daemon.status === 'ready' ? 'degraded' as const : 'not_ready' as const,
    reasons,
    warnings: runtimeHealth.warnings.map((item) => ({ code: item.code, message: item.message })),
    health: runtimeHealth,
    operationalView,
    daemon,
    durableScheduler: {
      status: runtimeHealth.components.scheduler.ready ? 'ready' : daemon.status === 'ready' ? 'degraded' : 'not_ready',
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
      activeAttentionCount: projection?.currentAttention.length ?? 0,
      consuming: (projection?.queueDepth ?? 0) === 0 || (projection?.runningWorkers ?? 0) > 0,
    },
    localBridge: repository ? {
      running: Boolean(localBridgeSurface?.enabled)
        && runtimeHealth.components.localBridge.ready
        && (!shouldProbeLocalBridge || (localBridgeEndpointReachable && localBridgeExpectedSurface)),
      endpoint: localBridgeEndpoint,
      error: localBridgeSurface?.error,
      inferredPid: localBridgeSurface?.pid,
      statusSource: localBridgeSurface?.source ?? 'none',
      activeSlot: observedSlot ? observedSlot === expectedActiveSlot : undefined,
      health: runtimeHealth.components.localBridge,
    } : undefined,
    projection,
    projectionSnapshot,
  };
}

async function capabilityRecoveryInput(ctx: MultiRepositoryMcpToolContext, repository: ReturnType<typeof selected>, args: Record<string, unknown>) {
  const readiness = await controllerReadiness(ctx, repository);
  const runtimeSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
  const localBridge = loadMcpRuntimeState(repository.canonicalRoot)?.localController;
  const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
  const contextProjection = readControllerContextProjection(ctx.controllerHome, repository.repoId);
  const contextProjectionSourceRevision = String(runtimeSnapshot.projection.metadata?.contentRevision ?? runtimeSnapshot.projection.revision);
  const contextProjectionStale = Boolean(contextProjection && controllerContextProjectionNeedsRefresh(contextProjection, contextProjectionSourceRevision));
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
  const plugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
    preferStored: true,
  });
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
    runtimeHealth: readiness.health as RuntimeHealthEvaluation,
    runtimeOperationalView: readiness.operationalView,
    connectorHealthy: undefined,
    runtimeProjectionStale: runtimeSnapshot.stale,
    runtimeProjectionPersisted: runtimeSnapshot.persisted,
    contextProjectionStale,
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

async function capabilityRecoverySnapshot(ctx: MultiRepositoryMcpToolContext, repository: ReturnType<typeof selected>, args: Record<string, unknown>) {
  return buildCapabilityRecoverySnapshot(await capabilityRecoveryInput(ctx, repository, args));
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

function summarizeWorkListItem(job: ExecutionJob): Record<string, unknown> {
  const digest = buildJobOperationDigest(job);
  return {
    workId: job.jobId,
    requestId: job.requestId,
    kind: 'execution_job',
    operation: typeof job.payload?.operation === 'string' ? job.payload.operation : job.type,
    status: job.status,
    phase: digest.phase,
    statusLabel: digest.statusLabel,
    summary: digest.summary,
    terminal: digest.terminal,
    resumable: !digest.terminal || digest.phase === 'needs_attention',
    errorClass: digest.errorClass,
    changedFileCount: digest.changedFiles?.length ?? 0,
    evidenceCount: job.evidenceIds.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    suggestedNextAction: digest.suggestedNextActions[0],
    detailPointer: { tool: 'work_get', work_id: job.jobId },
  };
}

function summarizeWorkContractListItem(contract: NonNullable<ReturnType<typeof getWorkContract>>): Record<string, unknown> {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(contract.status);
  return {
    workId: contract.workId,
    kind: 'work_contract',
    mode: contract.mode,
    objective: contract.objective,
    status: contract.status,
    phase: terminal ? 'completed' : contract.status === 'running' ? 'running' : 'attention',
    statusLabel: terminal ? '已完成' : contract.status === 'running' ? '运行中' : '待审查',
    summary: `WorkContract ${contract.status}: ${contract.objective.slice(0, 240)}`,
    terminal,
    resumable: !terminal,
    changedFileCount: 0,
    evidenceCount: contract.evidenceRefs.length,
    checkCount: contract.checkRefs.length,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
    suggestedNextAction: contract.suggestedNextActions[0],
    detailPointer: { tool: 'work_get', work_id: contract.workId },
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

function managedProcessOperationDigest(
  handle: NonNullable<ReturnType<typeof getProcessHandle>>,
): Record<string, unknown> {
  const terminal = handle.completed === true;
  const phase = terminal
    ? handle.ok === true
      ? 'succeeded'
      : handle.timedOut === true
        ? 'timed_out'
        : handle.cancelled === true
          ? 'cancelled'
          : 'failed'
    : 'running';
  return {
    schemaVersion: 1,
    operationId: handle.processId,
    operationType: 'managed-process',
    workRef: handle.processId,
    status: handle.status,
    phase,
    terminal,
    resumable: !terminal,
    completed: handle.completed === true,
    ok: handle.ok,
    exitCode: handle.exitCode,
    timedOut: handle.timedOut,
    cancelled: handle.cancelled,
    startedAt: handle.startedAt,
    summary: terminal
      ? `Managed process ${handle.processId} completed with status ${handle.status}.`
      : `Managed process ${handle.processId} is still ${handle.status}.`,
    suggestedNextActions: terminal ? [] : [{
      label: 'Poll managed process',
      tool: 'work_status_digest',
      operation: 'get',
      payload: { work_ref: handle.processId },
      risk: 'readonly',
      confidence: 'high',
    }],
  };
}

function invalidFacadeOperation(tool: FacadeTool, operation: string): CallToolResult {
  const allowed = allowedFacadeOperations(tool);
  const facade = buildFacadeResult({
    status: 'failed',
    summary: `Invalid ${tool} operation: ${operation || '<empty>'}.`,
    data: {
      tool,
      operation: operation || null,
      allowedOperations: [...allowed],
    },
    warnings: [`invalid_operation: ${tool} does not support "${operation}"`],
    suggestedNextActions: allowed.slice(0, 4).map((op) => ({
      label: `Try ${tool}.${op}`,
      tool,
      operation: op,
      risk: 'readonly' as const,
      confidence: 'high' as const,
    })),
    rawAvailable: false,
  });
  return result(facade as unknown as Record<string, unknown>, true);
}

function supervisorOperationKind(operation: string): SupervisorOperationKind | undefined {
  const values: Record<string, SupervisorOperationKind> = {
    runtime_restart_controller: 'restart_controller',
    runtime_restart_gateway: 'restart_gateway',
    runtime_restart_full: 'restart_full',
    runtime_rollout: 'rollout',
    runtime_rollback: 'rollback',
    runtime_unlock_and_recover: 'unlock_and_recover',
  };
  return values[operation];
}

async function runRuntimeSupervisorFacade(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const view = stableSupervisorFacadeStatus(ctx.controllerHome);
  if (operation === 'runtime_status') {
    const facade = buildFacadeResult({
      status: view.installed && !view.available ? 'blocked' : 'ok',
      summary: !view.installed
        ? 'Stable External Runtime Supervisor is not installed; legacy lifecycle remains the fallback.'
        : view.available
          ? 'Stable External Runtime Supervisor is running.'
          : 'Stable External Runtime Supervisor is installed but not currently available.',
      data: { runtimeSupervisor: view },
      warnings: !view.installed ? ['stable_supervisor_not_installed'] : view.available ? [] : ['stable_supervisor_unavailable'],
      suggestedNextActions: !view.installed ? [{ label: 'Install Stable Supervisor', tool: 'rh_work', operation: 'runtime_restart_full', risk: 'workspace_write', confidence: 'low', reason: 'Install the stable release before using Supervisor-owned recovery.' }] : [],
      rawAvailable: false,
      detailLevel: 'summary',
    });
    return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked');
  }
  if (operation === 'runtime_operation_get') {
    const operationId = typeof args.operation_id === 'string' ? args.operation_id.trim() : '';
    if (!operationId) return result({ error: { code: 'OPERATION_ID_REQUIRED', message: 'runtime_operation_get requires operation_id.' } }, true);
    const stored = stableSupervisorFacadeOperation(ctx.controllerHome, operationId);
    return result({ runtimeSupervisor: { installed: view.installed, operation: stored }, ...(stored ? {} : { error: { code: 'OPERATION_NOT_FOUND', operationId } }) }, !stored);
  }

  const kind = supervisorOperationKind(operation);
  if (!kind) return invalidFacadeOperation('rh_work', operation);
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) return result({ error: { code: 'REQUEST_ID_REQUIRED', message: `${operation} requires request_id for reconnect-safe idempotency.` } }, true);
  const reason = typeof args.reason === 'string' ? args.reason.slice(0, 500) : undefined;
  const accepted = await stableSupervisorFacadeMutation({
    controllerHome: ctx.controllerHome,
    requestId,
    kind,
    actor: 'rh_work',
    reason,
  });
  if (!accepted.installed && kind === 'restart_full') {
    const fallback = scheduleControllerServiceRestart({
      repo: repository.canonicalRoot,
      controllerHome: ctx.controllerHome,
      requestId,
      requestedBy: 'rh_work',
      reason,
      mode: 'detached',
    });
    return result(buildFacadeResult({
      status: 'ok',
      summary: 'Stable Supervisor is not installed; legacy restart coordinator accepted the restart request.',
      data: { runtimeSupervisor: { installed: false, fallback, mayDisconnect: true } },
      warnings: ['legacy_restart_coordinator_fallback'],
      suggestedNextActions: [{ label: 'Read restart status', tool: 'rh_status', operation: 'runtime_operation_get', payload: { operation_id: requestId }, risk: 'readonly', confidence: 'medium' }],
      rawAvailable: false,
      detailLevel: 'summary',
    }) as unknown as Record<string, unknown>);
  }
  if (!accepted.accepted || !accepted.operation) {
    return result(buildFacadeResult({
      status: accepted.installed ? 'blocked' : 'failed',
      summary: accepted.error ?? 'Stable Supervisor operation was not accepted.',
      data: { runtimeSupervisor: { installed: accepted.installed, available: view.available, requestId } },
      warnings: [accepted.error ?? 'supervisor_operation_not_accepted'],
      rawAvailable: false,
      detailLevel: 'summary',
    }) as unknown as Record<string, unknown>, true);
  }
  return result(buildFacadeResult({
    status: 'ok',
    summary: `${kind} accepted by the Stable External Runtime Supervisor.`,
    data: {
      runtimeSupervisor: {
        installed: true,
        accepted: true,
        deduplicated: accepted.deduplicated === true,
        operation: accepted.operation,
        operationId: accepted.operation.operationId,
        reconnectContract: accepted.operation.reconnectContract,
        mayDisconnect: true,
      },
    },
    suggestedNextActions: [{ label: 'Read runtime operation', tool: 'rh_status', operation: 'runtime_operation_get', payload: { operation_id: accepted.operation.operationId }, risk: 'readonly', confidence: 'high' }],
    rawAvailable: false,
    detailLevel: 'summary',
  }) as unknown as Record<string, unknown>);
}

async function runFacadeRepair(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  let maintenanceStatus: {
    readyForExecution?: boolean;
    recommendedActions?: string[];
    candidates?: Array<{ kind?: string; reason?: string; suggestedAction?: string; safe?: boolean }>;
    restartEscalation?: { recommended?: boolean; reason?: string };
    warnings?: string[];
  } | undefined;
  try {
    const status = buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, {
      minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
      maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 20,
      recentErrors: Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : undefined,
    });
    maintenanceStatus = {
      readyForExecution: status.readyForExecution,
      recommendedActions: status.recommendedActions,
      candidates: status.candidates.map((candidate) => ({
        kind: candidate.kind,
        reason: candidate.reason,
        suggestedAction: candidate.suggestedAction,
        safe: candidate.safe,
      })),
      restartEscalation: {
        recommended: status.restartEscalation.recommended,
        reason: status.restartEscalation.reason,
      },
      warnings: status.warnings,
    };
  } catch {
    maintenanceStatus = {
      readyForExecution: false,
      recommendedActions: [],
      candidates: [],
      warnings: ['runtime_maintenance_status inspection failed; treating as infrastructure issue, not acceptance failure'],
    };
  }

  let watchdogSummary: string | undefined;
  let performanceSummary: string | undefined;
  try {
    const watchdog = buildWorkflowWatchdogReport(ctx.controllerHome, repository, { includeProcesses: false });
    watchdogSummary = `status=${watchdog.status}; findings=${watchdog.findings.length}; stale=${watchdog.staleWork.length}`.slice(0, 240);
  } catch {
    watchdogSummary = undefined;
  }
  try {
    const perf = collectRuntimePerformanceDiagnostics({
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
      includeProcesses: false,
      includeTempDirs: false,
    });
    performanceSummary = perf.summary.slice(0, 240);
  } catch {
    performanceSummary = undefined;
  }

  const daemon = readControllerDaemonStatus(ctx.controllerHome);
  const readiness = await controllerReadiness(ctx, repository);
  const facade = runSelfHealingLoop(
    { repoId: repository.repoId, handoffStore: store },
    {
      operation: args.repair_operation === 'repair' || args.repair_operation === 'verify' || args.repair_operation === 'handoff'
        ? args.repair_operation
        : 'diagnose',
      dryRun: args.dry_run === undefined ? true : args.dry_run === true,
      approvalConfirmed: args.approval_confirmed === true,
      workId: typeof args.work_id === 'string' ? args.work_id : undefined,
      chatgptPullFailed: args.chatgpt_pull_failed === true,
      destructive: args.destructive === true,
      processKillOrRestart: args.process_kill_or_restart === true,
      remoteEffect: args.remote_write === true || args.remote_effect === true,
      maintenanceStatus,
      diagnostics: {
        watchdogSummary,
        performanceSummary,
        controllerDaemonUnhealthy: daemon.status !== 'ready',
        schedulerUnhealthy: readiness.durableScheduler.status !== 'ready',
        codexUnavailable: args.codex_available === false,
        grokUnavailable: args.grok_available === false || args.target === 'grok',
        pluginUnavailable: args.plugin_unavailable === true,
      },
    },
  );
  if (
    args.repair_operation === 'repair'
    && args.dry_run === false
    && args.approval_confirmed === true
    && args.process_kill_or_restart === true
  ) {
    const restart = scheduleControllerServiceRestart({
      repo: repository.canonicalRoot,
      controllerHome: ctx.controllerHome,
      requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
      requestedBy: 'rh_status.repair',
      reason: 'Authorized self-healing repair requested a full Controller stack restart',
      mode: 'detached',
    });
    return result({
      ...(facade as unknown as Record<string, unknown>),
      status: 'applied',
      summary: 'Authorized repair scheduled a durable out-of-band Controller stack restart.',
      restart,
    });
  }
  return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked' || facade.status === 'approval_required' || facade.status === 'failed');
}

function runFacadeVerify(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): CallToolResult {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const checks = listControllerChecks(repository.canonicalRoot);
  const workloopCtx = {
    workStore: store,
    handoffStore: store,
    repoId: repository.repoId,
    availableChecks: checks,
  };
  const workId = typeof args.work_id === 'string' ? args.work_id : '';
  const checkId = String(args.check_id ?? args.checkId ?? '');
  const classified = classifyVerificationOutcome({
    checkId,
    available: checks,
  });

  if (classified.outcome === 'invalid_check_id') {
    if (workId) {
      const facade = verifyGoalWorkloop(workloopCtx, { workId, checkId });
      return result(facade as unknown as Record<string, unknown>);
    }
    return result(buildFacadeResult({
      status: 'ok',
      summary: classified.summary,
      data: {
        verification: {
          checkId,
          outcome: 'invalid_check_id',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
          doesNotRequestTaskChanges: true,
        },
        registeredCheckCount: checks.length,
      },
      warnings: classified.warnings,
      suggestedNextActions: normalizeCheckIds(checks.slice(0, 3).map((check) => check.id), checks).suggestedNextActions,
    }) as unknown as Record<string, unknown>);
  }

  // Simulation path for unit tests / explicit dry verification without process execution.
  if (args.simulate_check === true || args.infrastructure_failed === true || args.check_failed === true || args.skipped === true) {
    if (!workId) {
      return result(buildFacadeResult({
        status: args.check_failed === true ? 'failed' : 'ok',
        summary: 'Simulated verification without WorkContract.',
        data: {
          verification: {
            checkId: classified.normalizedCheckId,
            outcome: args.skipped ? 'skipped' : args.infrastructure_failed ? 'infrastructure_failure' : args.check_failed ? 'valid_fail' : 'valid_pass',
            isAcceptanceFailure: args.check_failed === true,
            simulated: true,
          },
        },
      }) as unknown as Record<string, unknown>, args.check_failed === true);
    }
    const facade = verifyGoalWorkloop(workloopCtx, {
      workId,
      checkId: classified.normalizedCheckId ?? checkId,
      infrastructureFailed: args.infrastructure_failed === true,
      checkFailed: args.check_failed === true,
      skipped: args.skipped === true,
    });
    return result(facade as unknown as Record<string, unknown>, facade.status === 'failed');
  }

  // Real registered check execution path.
  try {
    const executed = runControllerCheck(repository.canonicalRoot, classified.normalizedCheckId!);
    const infrastructureFailed = executed.failureClass === 'infrastructure_failure'
      || executed.timedOut === true;
    const checkFailed = !executed.ok && !infrastructureFailed;
    if (workId) {
      const facade = verifyGoalWorkloop(workloopCtx, {
        workId,
        checkId: classified.normalizedCheckId!,
        infrastructureFailed,
        checkFailed,
      });
      const data = facade.data as Record<string, unknown>;
      return result({
        ...facade,
        data: {
          ...data,
          verification: {
            ...(typeof data.verification === 'object' && data.verification ? data.verification as Record<string, unknown> : {}),
            executed: true,
            registeredCheckId: classified.normalizedCheckId,
            ok: executed.ok,
            timedOut: executed.timedOut,
            failureClass: executed.failureClass,
            cacheHit: executed.cacheHit,
            validatedRevision: executed.validatedRevision,
            originalExecutedAt: executed.originalExecutedAt,
            // Never return raw stdout/stderr to ChatGPT by default.
            evidenceArtifactPath: executed.artifactPath,
            boundedStatus: executed.ok ? 'pass' : infrastructureFailed ? 'infrastructure_failure' : 'fail',
          },
        },
      } as unknown as Record<string, unknown>, facade.status === 'failed');
    }
    return result(buildFacadeResult({
      status: checkFailed ? 'failed' : 'ok',
      summary: infrastructureFailed
        ? `Infrastructure failure while running ${classified.normalizedCheckId}; not an acceptance failure.`
        : executed.ok
          ? `Check ${classified.normalizedCheckId} passed.`
          : `Check ${classified.normalizedCheckId} failed acceptance.`,
      data: {
        verification: {
          checkId: classified.normalizedCheckId,
          outcome: infrastructureFailed ? 'infrastructure_failure' : executed.ok ? 'valid_pass' : 'valid_fail',
          isAcceptanceFailure: checkFailed,
          isInfrastructureIssue: infrastructureFailed,
          executed: true,
          evidenceArtifactPath: executed.artifactPath,
          cacheHit: executed.cacheHit,
          validatedRevision: executed.validatedRevision,
          originalExecutedAt: executed.originalExecutedAt,
          failureClass: executed.failureClass,
        },
      },
      warnings: infrastructureFailed ? ['infrastructure_failure is distinct from acceptance failure'] : [],
      suggestedNextActions: executed.ok
        ? [{ label: 'Continue work', tool: 'rh_work', operation: 'continue', payload: { work_id: workId || undefined }, risk: 'readonly' }]
        : [{ label: 'Diagnose if infrastructure', tool: 'rh_work', operation: 'repair', payload: { repair_operation: 'diagnose', dry_run: true }, risk: 'readonly' }],
      rawAvailable: false,
    }) as unknown as Record<string, unknown>, checkFailed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (workId) {
      const facade = verifyGoalWorkloop(workloopCtx, {
        workId,
        checkId: classified.normalizedCheckId ?? checkId,
        infrastructureFailed: true,
      });
      return result({
        ...facade,
        warnings: [...facade.warnings, `check_runner_error: ${message.slice(0, 200)}`],
        data: {
          ...(facade.data as Record<string, unknown>),
          isAcceptanceFailure: false,
        },
      } as unknown as Record<string, unknown>);
    }
    return result(buildFacadeResult({
      status: 'ok',
      summary: `Infrastructure failure invoking check runner for ${classified.normalizedCheckId}; not acceptance failure.`,
      data: {
        verification: {
          checkId: classified.normalizedCheckId,
          outcome: 'infrastructure_failure',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
        },
      },
      warnings: [`check_runner_error: ${message.slice(0, 200)}`],
      suggestedNextActions: [{
        label: 'Diagnose runtime (dry-run)',
        tool: 'rh_work',
        operation: 'repair',
        payload: { repair_operation: 'diagnose', dry_run: true },
        risk: 'readonly',
      }],
    }) as unknown as Record<string, unknown>);
  }
}

/**
 * Runtime Source drift for MCP readiness.
 *
 * `currentRuntimeRoot` is only for tests that pin a Controller Runtime Source
 * fixture. Callers must never pass an execution repository canonicalRoot here.
 */
export function runtimeSourceSnapshotStatus(
  active: RuntimeSourceIdentity | undefined,
  currentRuntimeRoot?: string,
) {
  const drift = evaluateActiveRuntimeSourceDrift(active, {
    currentRuntimeRoot,
  });
  return {
    current: drift.current,
    restartRequired: drift.restartRequired,
    reasons: drift.reasons,
    code: drift.code,
  };
}

export async function callRuntimeTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'rh_status': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? 'get');
        if (!allowedFacadeOperations('rh_status').includes(operation)) {
          return invalidFacadeOperation('rh_status', operation);
        }
        if (operation === 'runtime_status' || operation === 'runtime_operation_get') {
          return await runRuntimeSupervisorFacade(ctx, repository, operation, args);
        }
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        if (operation === 'repair') {
          return await runFacadeRepair(ctx, repository, args);
        }
        const readiness = await controllerReadiness(ctx, repository);
        const liveGit = gitSnapshot(repository.canonicalRoot);
        // Compare startup Runtime Source against the Controller package authority —
        // never against the selected execution repository.
        const runtimeSource = runtimeSourceSnapshotStatus(readiness.daemon.source);
        const sourceSnapshotStale = runtimeSource.restartRequired;
        // Dynamic import avoids a static cycle: toolset.ts composes runtimeToolDefinitions.
        const toolset = await import('../../../cli/mcp/toolset');
        const exposure = toolset.controllerExposureSnapshot(ctx);
        const localRegisteredToolNames = toolset.allControllerToolDefinitions(ctx).map((tool) => tool.name).sort();
        const toolSurfaceReady = exposure.ready && exposure.missingToolNames.length === 0;
        const effectiveReady = readiness.ready && toolSurfaceReady && !sourceSnapshotStale;
        const readinessReasons = [...readiness.reasons];
        if (!toolSurfaceReady) {
          readinessReasons.push({
            code: 'MCP_TOOL_SURFACE_INCOMPLETE',
            message: `MCP schema mismatch: missing=${exposure.missingToolNames.length}, duplicates=${exposure.duplicateToolNames.length}.`,
          });
        }
        if (sourceSnapshotStale) {
          readinessReasons.push({
            code: runtimeSource.code === 'RUNTIME_SOURCE_SNAPSHOT_MISSING'
              ? 'RUNTIME_SOURCE_SNAPSHOT_MISSING'
              : runtimeSource.code === 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE'
                ? 'RUNTIME_SOURCE_CURRENT_UNAVAILABLE'
                : 'RUNTIME_SOURCE_SNAPSHOT_STALE',
            message: formatRuntimeSourceDriftMessage(runtimeSource),
          });
        }
        const readinessWithToolSurface = {
          ...readiness,
          ready: effectiveReady,
          state: effectiveReady ? readiness.state : 'degraded' as const,
          reasons: readinessReasons,
          toolSurface: {
            ready: toolSurfaceReady,
            expectedToolCount: exposure.expectedToolNames.length,
            actualToolCount: exposure.actualToolNames.length,
            missingTools: exposure.missingToolNames,
            unexpectedTools: exposure.unexpectedToolNames,
            duplicateTools: exposure.duplicateToolNames,
            fingerprint: exposure.fingerprint,
            schemaStableAcrossAccessModes: exposure.schemaStableAcrossAccessModes,
          },
        };
        const detailLevel = args.detail_level === 'detail' ? 'detail' : 'summary';
        // Always prefer stored plugin manifests on rh_status get. Live host probes
        // (Xcode/simctl, etc.) must not stall Managed MCP gateways on reconnect/status.
        const manifests = listAssistantPluginManifests(ctx.controllerHome, repository, {
          preferStored: true,
        });
        const capabilities = listCapabilityDescriptors(manifests);
        const pendingHandoffs = listHandoffItems({ ...store, status: 'pending', limit: 20 });
        const activeWork = listWorkContracts({ ...store, status: 'active', limit: 20 });
        const preferredFacadeTools = ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'] as const;
        const facade = buildFacadeResult({
          status: effectiveReady ? 'ok' : 'blocked',
          summary: effectiveReady ? 'Controller and MCP tool surface are ready for bounded work.' : 'Controller or MCP tool surface needs attention before work.',
          data: {
            operation,
            repoId: repository.repoId,
            readiness: readinessWithToolSurface,
            repositoryState: {
              ...liveGit,
              observedAt: new Date().toISOString(),
              sourceSnapshotAgeMs: readiness.daemon.source?.observedAt
                ? Math.max(0, Date.now() - Date.parse(readiness.daemon.source.observedAt))
                : undefined,
              sourceSnapshotStale,
              sourceSnapshotReasons: runtimeSource.reasons,
              runtimeSourceDirty: runtimeSource.current?.dirty === true,
            },
            capabilityCount: capabilities.length,
            capabilityGroups: summarizeCapabilityGroups(manifests),
            toolArchitecture: {
              facadeTools: [...preferredFacadeTools],
              atomicTypedToolsRetained: true,
              internalHandlersRetained: true,
              domainSchemaLoading: 'static_stable_surface',
              dynamicDomainSchemaLoadingSupported: false,
            },
            pendingHandoffCount: pendingHandoffs.length,
            activeWorkCount: activeWork.length,
            // Summary keeps the stable facade surface only; detail expands to the full registered schema.
            toolSurface: detailLevel === 'detail'
              ? exposure.actualToolNames
              : preferredFacadeTools.filter((name) => exposure.actualToolNames.includes(name)),
            toolSurfaceStatus: readinessWithToolSurface.toolSurface,
            access: exposure.access,
          },
          suggestedNextActions: pendingHandoffs.length > 0 ? [{
            label: 'Review pending handoffs',
            tool: 'rh_inbox',
            operation: 'list',
            risk: 'readonly',
            confidence: 'high',
          }] : [{
            label: 'Read repository context',
            tool: 'rh_context',
            operation: 'get',
            risk: 'readonly',
            confidence: 'medium',
          }],
          rawAvailable: detailLevel === 'detail',
          detailLevel,
        });
        return result(facade as unknown as Record<string, unknown>, facade.status !== 'ok');
      }
      case 'rh_inbox': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? 'list');
        if (!allowedFacadeOperations('rh_inbox').includes(operation)) {
          return invalidFacadeOperation('rh_inbox', operation);
        }
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        if (operation === 'get') {
          const item = getHandoffItem(store, String(args.handoff_id ?? ''));
          const facade = buildFacadeResult({
            status: item ? 'ok' : 'not_found',
            summary: item ? `Handoff ${item.id}.` : 'Handoff item not found.',
            data: { item },
            suggestedNextActions: item && item.status === 'pending' ? [{ label: 'Acknowledge handoff', tool: 'rh_inbox', operation: 'ack', payload: { handoff_id: item.id }, risk: 'readonly' }] : [],
          });
          return result(facade as unknown as Record<string, unknown>, facade.status === 'not_found');
        }
        if (operation === 'ack') {
          const item = acknowledgeHandoffItem(store, String(args.handoff_id ?? '').trim());
          return result(buildFacadeResult({
            summary: `Acknowledged handoff ${item.id}.`,
            data: { item },
            suggestedNextActions: item.suggestedNextActions,
          }) as unknown as Record<string, unknown>);
        }
        if (operation === 'resolve') {
          const item = resolveHandoffItem(store, String(args.handoff_id ?? '').trim(), {
            decision: String(args.decision ?? 'resolved'),
            resolver: String(args.resolver ?? 'chatgpt'),
          });
          return result(buildFacadeResult({
            summary: `Resolved handoff ${item.id}.`,
            data: { item: { id: item.id, status: item.status, decision: item.decision, resolver: item.resolver } },
          }) as unknown as Record<string, unknown>);
        }
        if (operation === 'dismiss') {
          const item = dismissHandoffItem(store, String(args.handoff_id ?? '').trim(), {
            decision: String(args.decision ?? 'dismissed'),
            resolver: String(args.resolver ?? 'chatgpt'),
          });
          return result(buildFacadeResult({
            summary: `Dismissed handoff ${item.id}.`,
            data: { item: { id: item.id, status: item.status, decision: item.decision, resolver: item.resolver } },
          }) as unknown as Record<string, unknown>);
        }
        if (operation === 'create') {
          const id = String(args.handoff_id ?? `hnd-${Date.now()}`).trim();
          const item = createHandoffItem(store, {
            id,
            repoId: repository.repoId,
            workId: typeof args.work_id === 'string' ? args.work_id : undefined,
            title: String(args.title ?? 'Controller handoff'),
            severity: 'needs_review',
            creationReason: 'ambiguous_outcome',
            reason: String(args.reason ?? 'ChatGPT or user judgement is required before continuing.'),
            summary: String(args.summary ?? 'A bounded controller handoff was recorded.'),
            currentState: { repoId: repository.repoId, statusSummary: 'pending decision', workId: typeof args.work_id === 'string' ? args.work_id : undefined },
            attemptedActions: Array.isArray(args.attempted_actions) ? args.attempted_actions.map(String) : [],
            evidenceRefs: [],
            blockingDecision: typeof args.blocking_decision === 'string' ? args.blocking_decision : undefined,
            recommendedDecision: String(args.recommended_decision ?? 'Decide whether to continue, repair, or stop.'),
            recommendedPrompt: String(args.recommended_prompt ?? `Continue from handoff ${id}.`),
            recommendedContinuationPrompt: typeof args.recommended_continuation_prompt === 'string' ? args.recommended_continuation_prompt : undefined,
            suggestedNextActions: [],
          });
          return result(buildFacadeResult({ summary: `Created handoff ${item.id}.`, data: { item: summarizeHandoffItem(item) } }) as unknown as Record<string, unknown>);
        }
        // Default list: pending summary only.
        const items = listHandoffItems({ ...store, status: 'pending', limit: typeof args.limit === 'number' ? args.limit : 50 });
        return result(buildFacadeResult({
          summary: items.length ? `${items.length} pending handoff item(s).` : 'No pending handoff items.',
          data: { items: items.map(summarizeHandoffItem) },
          suggestedNextActions: items.slice(0, 1).map((item) => ({ label: `Read ${item.id}`, tool: 'rh_inbox', operation: 'get', payload: { handoff_id: item.id }, risk: 'readonly' as const })),
        }) as unknown as Record<string, unknown>);
      }
      case 'rh_context': {
        const repository = selected(ctx, args);
        const operation = String(args.operation ?? 'get');
        if (!allowedFacadeOperations('rh_context').includes(operation)) {
          return invalidFacadeOperation('rh_context', operation);
        }
        const checks = listControllerChecks(repository.canonicalRoot);
        const requested = Array.isArray(args.requested_check_ids) ? args.requested_check_ids.map(String) : [];
        const normalizedChecks = normalizeCheckIds(requested, checks);
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        const workId = typeof args.work_id === 'string' ? args.work_id : undefined;
        const work = workId ? getWorkContract(store, workId) : undefined;
        const executionJob = workId && !work ? (() => { try { return getExecutionJob(ctx.controllerHome, repository.repoId, workId); } catch { return undefined; } })() : undefined;
        if (workId && !work && !executionJob) {
          const facade = buildFacadeResult({
            status: 'not_found',
            summary: `Work ${workId} not found in this repository.`,
            data: { operation, repoId: repository.repoId, workId },
            suggestedNextActions: [],
          });
          return result(facade as unknown as Record<string, unknown>, true);
        }
        const detailLevel = args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary';
        const boundedSummaryLimit = 5;
        const activeContracts = operation === 'list' || !workId
          ? listWorkContracts({ ...store, status: 'active', limit: detailLevel === 'summary' ? boundedSummaryLimit : 20 })
          : [];
        const recentJobs = operation === 'list' || !workId
          ? listExecutionJobs(ctx.controllerHome, repository.repoId, detailLevel === 'summary' ? boundedSummaryLimit : 20)
          : [];
        const manifests = listAssistantPluginManifests(ctx.controllerHome, repository, {
          preferStored: true,
        });
        const capabilities = listCapabilityDescriptors(manifests);
        const selectedChecks = normalizedChecks.validCheckIds
          .map((id) => checks.find((check) => check.id === id))
          .filter((check): check is (typeof checks)[number] => Boolean(check))
          .map((check) => ({ id: check.id, description: check.description, source: check.source }));
        const attention = listHandoffItems({ ...store, status: 'pending', limit: boundedSummaryLimit }).map(summarizeHandoffItem);
        const checkSummaries = detailLevel === 'summary'
          ? selectedChecks
          : checks.map((check) => ({ id: check.id, description: check.description, source: check.source }));
        const facade = buildFacadeResult({
          status: 'ok',
          summary: work
            ? `Bounded context for work ${work.workId}.`
            : executionJob
              ? `Bounded context for execution job ${executionJob.jobId}.`
              : 'Bounded repository context and active work summaries are available.',
          data: {
            operation,
            repoId: repository.repoId,
            repository: repositorySummary(repository),
            checks: checkSummaries,
            selectedChecks,
            requestedCheckIds: requested,
            normalizedChecks,
            invalidCheckIdsAreNotFailures: true,
            capabilityCount: capabilities.length,
            ...(detailLevel === 'summary' ? {} : { capabilities }),
            capabilityGroups: summarizeCapabilityGroups(manifests),
            toolArchitecture: {
              facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
              atomicTypedToolsRetained: true,
              internalHandlersRetained: true,
              domainSchemaLoading: 'static_stable_surface',
              dynamicDomainSchemaLoadingSupported: false,
            },
            work: work && detailLevel === 'summary'
              ? { workId: work.workId, status: work.status, mode: work.mode, objective: work.objective.slice(0, 240) }
              : work,
            executionJob: executionJob ? summarizeWorkListItem(executionJob) : undefined,
            activeWork: activeContracts.map((entry) => ({
              workId: entry.workId, status: entry.status, mode: entry.mode, objective: entry.objective.slice(0, 240),
            })),
            recentExecutionJobs: recentJobs.map(summarizeWorkListItem),
            activeAttention: attention,
            counts: {
              availableChecks: checks.length,
              selectedChecks: selectedChecks.length,
              capabilities: capabilities.length,
              activeWork: activeContracts.length,
              recentExecutionJobs: recentJobs.length,
              activeAttention: attention.length,
            },
            bounded: detailLevel === 'summary',
          },
          warnings: normalizedChecks.warnings,
          evidenceRefs: work?.evidenceRefs?.slice(0, 5) ?? [],
          suggestedNextActions: normalizedChecks.suggestedNextActions.length ? normalizedChecks.suggestedNextActions : [{
            label: 'Choose work mode',
            tool: 'rh_work',
            operation: 'start',
            risk: 'workspace_write',
            confidence: 'medium',
          }],
          detailLevel,
          rawAvailable: detailLevel === 'raw',
        });
        return result(facade as unknown as Record<string, unknown>);
      }
      case 'rh_work': {
        const repository = selected(ctx, args);
        const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
        const operation = String(args.operation ?? 'start');
        if (!allowedFacadeOperations('rh_work').includes(operation)) {
          return invalidFacadeOperation('rh_work', operation);
        }
        if (operation.startsWith('runtime_')) {
          return await runRuntimeSupervisorFacade(ctx, repository, operation, args);
        }
        const checks = listControllerChecks(repository.canonicalRoot);
        const workloopCtx = {
          workStore: store,
          handoffStore: store,
          repoId: repository.repoId,
          availableChecks: checks,
        };

        if (operation === 'repair') {
          return await runFacadeRepair(ctx, repository, args);
        }

        if (operation === 'verify') {
          return runFacadeVerify(ctx, repository, args);
        }

        if (operation === 'delegate') {
          const facade = delegateToCodexCerebellum(
            { repoId: repository.repoId, workStore: store, handoffStore: store },
            {
              workId: typeof args.work_id === 'string' ? args.work_id : undefined,
              target: args.target === 'grok' || args.target === 'claude' || args.target === 'codex' ? args.target : 'codex',
              objective: typeof args.objective === 'string' ? args.objective : 'Delegated cerebellum work',
              acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
              allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
              forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
              available: typeof args.available === 'boolean' ? args.available : undefined,
              codexAvailable: args.codex_available !== false,
              workerOutput: args.worker_output && typeof args.worker_output === 'object' && !Array.isArray(args.worker_output)
                ? args.worker_output as { uncertain?: boolean; summary?: string; patchProposal?: string; evidenceSummary?: string }
                : undefined,
            },
          );
          return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked');
        }

        const facade = runGoalWorkloop(workloopCtx, operation as 'start' | 'continue' | 'finalize' | 'stop', args);
        return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked' || facade.status === 'failed' || facade.status === 'not_found');
      }
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
        }, { allowReadOnly: true, forceDurable: true });
        if (!routed?.structuredContent || routed.isError) {
          throw new Error(`WORK_OPERATION_NOT_DURABLE: ${operation} is unknown or not eligible for durable execution`);
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
        let job = resolveWorkJob(ctx, repository.repoId, args);
        if (!job) {
          const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
          const contract = workId
            ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, workId)
            : undefined;
          if (contract) {
            const work = summarizeWorkContractListItem(contract);
            return result({
              work,
              workContract: contract,
              summary: work.summary,
              phase: work.phase,
              statusLabel: work.statusLabel,
              waited: false,
              timedOut: false,
              waitedMs: 0,
              next: contract.status === 'running'
                ? 'Continue or verify this WorkContract through rh_work.'
                : 'Inspect retained evidence and decide whether to continue, finalize, or stop through rh_work.',
            });
          }
          return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
        }
        let timedOut = false;
        let waitedMs = 0;
        if (args.wait === true) {
          const waited = await waitForExecutionJob({
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            jobId: job.jobId,
            timeoutMs: typeof args.wait_ms === 'number' ? args.wait_ms : 15_000,
          });
          job = waited.job;
          timedOut = waited.timedOut;
          waitedMs = waited.waitedMs;
        }
        const digest = buildJobOperationDigest(job, { waited: args.wait === true, stillRunning: timedOut });
        return result({
          work: summarizeWork(job, repository.canonicalRoot),
          digest,
          summary: digest.summary,
          phase: digest.phase,
          statusLabel: digest.statusLabel,
          errorClass: digest.errorClass,
          errorMessage: digest.errorMessage,
          waited: args.wait === true || typeof args.wait_ms === 'number',
          timedOut,
          waitedMs,
          ...(args.include_events === true ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) } : {}),
        }, digest.phase === 'failed' || digest.phase === 'timed_out');
      }
      case 'work_wait': {
        const repository = selected(ctx, args);
        const job = resolveWorkJob(ctx, repository.repoId, args);
        const waitMs = typeof args.wait_ms === 'number' ? args.wait_ms : 15_000;
        if (!job) {
          const processRef = String(args.work_id ?? args.request_id ?? '').trim();
          const process = getProcessHandle(ctx.controllerHome, repository.repoId, processRef);
          if (!process) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work or managed process matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
          const waitedProcess = await waitForProcess(ctx.controllerHome, repository.repoId, processRef, { timeoutMs: waitMs });
          const digest = managedProcessOperationDigest(waitedProcess);
          return result({
            work: { kind: 'managed_process', processId: processRef },
            digest,
            summary: digest.summary,
            phase: digest.phase,
            suggestedNextActions: digest.suggestedNextActions,
            waited: true,
            timedOut: waitedProcess.completed !== true,
            waitedMs: waitMs,
          }, digest.phase === 'failed' || digest.phase === 'timed_out');
        }
        const waited = await waitForExecutionJob({
          controllerHome: ctx.controllerHome,
          repoId: repository.repoId,
          jobId: job.jobId,
          timeoutMs: waitMs,
        });
        const digest = buildJobOperationDigest(waited.job, { waited: true, stillRunning: waited.timedOut });
        return result({
          work: summarizeWork(waited.job, repository.canonicalRoot),
          digest,
          summary: digest.summary,
          phase: digest.phase,
          statusLabel: digest.statusLabel,
          errorClass: digest.errorClass,
          errorMessage: digest.errorMessage,
          changedFiles: digest.changedFiles,
          suggestedNextActions: digest.suggestedNextActions,
          waited: true,
          timedOut: waited.timedOut,
          waitedMs: waited.waitedMs,
        }, digest.phase === 'failed' || digest.phase === 'timed_out');
      }
      case 'work_list': {
        const repository = selected(ctx, args);
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(Math.trunc(args.limit), 100)) : 50;
        const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, limit).map(summarizeWorkListItem);
        const contracts = listWorkContracts({
          controllerHome: ctx.controllerHome,
          repoId: repository.repoId,
          status: 'all',
          limit,
        }).map(summarizeWorkContractListItem);
        const works = [...jobs, ...contracts]
          .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
          .slice(0, limit);
        return result({ detailLevel: 'summary', works, next: 'Call work_get for bounded details.' });
      }
      case 'work_cancel': {
        const repository = selected(ctx, args);
        const job = resolveWorkJob(ctx, repository.repoId, args);
        if (!job) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work matched this repository and identifier.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
        const cancelled = await cancelExecutionJob(
          ctx.controllerHome,
          repository.repoId,
          job.jobId,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        const digest = buildJobOperationDigest(cancelled);
        return result({ work: summarizeWork(cancelled, repository.canonicalRoot), digest, summary: digest.summary, phase: digest.phase });
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
        const detailLevel = args.detail_level === 'detail' || args.detail === true ? 'detail' : 'summary';
        const surface = resolveLocalBridgeSurface({
          controllerHome: ctx.controllerHome,
          repoRoot: repository.canonicalRoot,
          // Process scan is expensive; only for detail or missing runtime state.
          allowProcessScan: detailLevel === 'detail',
        });
        const runtime = loadMcpRuntimeState(repository.canonicalRoot);
        const endpoint = surface.endpoint;
        const shouldProbe = surface.enabled
          && surface.endpointConfigured
          && Boolean(endpoint)
          && surface.mode !== 'disabled';
        const liveHealth = shouldProbe ? await probeLocalControllerHealth(endpoint) : null;
        const endpointReachable = liveHealth !== null;
        const expectedSurface = shouldProbe
          ? isExpectedLocalControllerHealth(liveHealth, {
            repoRoot: repository.canonicalRoot,
            generation: surface.generation ?? runtime?.generation,
          })
          : false;
        const expectedActiveSlot = readActiveSlotAuthority(ctx.controllerHome).activeSlot;
        const observedSlot = liveHealth?.slot === 'blue' || liveHealth?.slot === 'green' ? liveHealth.slot : undefined;
        const activeSlot = observedSlot ? observedSlot === expectedActiveSlot : undefined;
        const processAlive = surface.processRunning;
        const projectionSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
        const daemon = readControllerDaemonStatus(ctx.controllerHome);
        const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
        const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
        const schedulerDispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
        const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
        const health = evaluateRuntimeHealth({
          daemon: {
            status: daemon.status,
            error: daemon.error,
            heartbeatAgeMs: schedulerHeartbeatAgeMs,
          },
          scheduler: {
            status: daemon.degraded ? 'degraded' : daemon.status,
            heartbeatAgeMs: schedulerHeartbeatAgeMs,
            dispatchHeartbeatAgeMs: schedulerDispatchHeartbeatAgeMs,
          },
          workers: {
            queueDepth: projectionSnapshot.projection.queueDepth,
            runningWorkers: projectionSnapshot.projection.runningWorkers,
            activeLeases: projectionSnapshot.projection.activeLeases,
            activeAttentionCount: projectionSnapshot.projection.currentAttention.length,
          },
          projection: projectionObservation(projectionSnapshot),
          localBridge: {
            enabled: surface.enabled,
            requiredForReadiness: surface.requiredForReadiness,
            mode: surface.mode,
            endpoint,
            // When endpoint is not configured (disabled/unknown), treat as non-issue.
            endpointReachable: shouldProbe ? endpointReachable : true,
            expectedSurface: shouldProbe ? expectedSurface : true,
            activeSlot,
            generationMatches: surface.generation && liveHealth?.generation
              ? liveHealth.generation === surface.generation
              : (runtime?.generation && liveHealth?.generation
                ? liveHealth.generation === runtime.generation
                : undefined),
            processAlive,
            runtimeStateFresh: surface.source === 'service-runtime' || surface.source === 'repo-runtime',
            error: surface.error,
          },
          runtimeStorage: {
            readable: true,
            ready: runtimeStorage.readyForExecution,
            warnings: runtimeStorage.warnings,
          },
        });
        const jobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, detailLevel === 'detail' ? 12 : 20);
        const { activeJobCount, recentJobSummary } = summarizeRecentJobs(jobs);
        const running = surface.enabled
          && health.components.localBridge.ready
          && (!shouldProbe || (endpointReachable && expectedSurface));
        // Historical job counts are operational stats, not current readiness blockers.
        const bridgeWarnings = health.components.localBridge.warnings
          .filter((warning) => warning.code !== 'LOCAL_BRIDGE_ENDPOINT_UNAVAILABLE'
            || surface.requiredForReadiness
            || shouldProbe)
          .map((warning) => ({ code: warning.code, message: warning.message }));

        if (detailLevel === 'summary') {
          return result({
            localBridgeSummary: true,
            omitEnvelope: true,
            detailLevel: 'summary',
            repoId: repository.repoId,
            running,
            ready: health.components.localBridge.ready,
            health: health.components.localBridge.state,
            mode: surface.mode,
            endpoint: endpoint ?? null,
            endpointConfigured: surface.endpointConfigured,
            endpointReachable: shouldProbe ? endpointReachable : null,
            processRunning: processAlive ?? null,
            expectedSurface: surface.expectedSurface,
            requiredForReadiness: surface.requiredForReadiness,
            ...(surface.activeSlot ? { activeSlot: surface.activeSlot } : {}),
            warnings: bridgeWarnings,
            activeJobCount,
            recentJobSummary,
            statusSource: surface.source,
            nonBlocking: !surface.requiredForReadiness,
          });
        }

        return result({
          detailLevel: 'detail',
          endpoint: endpoint ?? null,
          endpointConfigured: surface.endpointConfigured,
          running,
          capability: {
            enabled: surface.enabled,
            requiredForReadiness: surface.requiredForReadiness,
            mode: surface.mode,
            health: health.components.localBridge.state,
            ready: health.components.localBridge.ready,
            endpointReachable: shouldProbe ? endpointReachable : null,
            expectedSurface: shouldProbe ? expectedSurface : null,
            activeSlot,
            generationMatches: surface.generation && liveHealth?.generation
              ? liveHealth.generation === surface.generation
              : undefined,
            observedAt: new Date().toISOString(),
            owner: {
              kind: surface.ownerKind,
              ...(surface.pid ? { pid: surface.pid } : {}),
              ...(surface.generation ? { generation: surface.generation } : {}),
              ...(observedSlot ? { slot: observedSlot } : {}),
            },
            evidence: {
              endpointReachable: shouldProbe ? endpointReachable : null,
              expectedSurface: shouldProbe ? expectedSurface : null,
              ...(processAlive !== undefined ? { processAlive } : {}),
              runtimeStateFresh: surface.source === 'service-runtime' || surface.source === 'repo-runtime',
              observedAt: new Date().toISOString(),
            },
          },
          health: {
            state: health.state,
            ready: health.ready,
            // Do not elevate historical job failures into active blockers.
            activeBlockers: health.activeBlockers,
            warnings: health.warnings,
          },
          error: surface.error,
          statusSource: surface.source,
          counts: recentJobSummary,
          activeJobCount,
          recentJobSummary,
          approvalQueue: false,
          reconciliation: { scanned: jobs.length, active: activeJobCount, terminalized: 0, deferredToController: true },
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
          runtimeStorage,
          nonBlocking: !surface.requiredForReadiness,
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
        const contextSourceRevision = String(runtimeProjection.metadata?.contentRevision ?? runtimeProjection.revision);
        const cached = readControllerContextProjection(ctx.controllerHome, repository.repoId);
        const projectionAgeMs = controllerContextProjectionAgeMs(cached);
        const readiness = await controllerReadiness(ctx, repository);
        const activeCheckout = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
        const liveGit = gitSnapshot(repository.canonicalRoot);
        const board = projectBoard(repository.canonicalRoot);
        const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
        const operationalPlan = buildControllerOperationalPlan(repository.canonicalRoot, taskLedger);
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
        const plugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
          preferStored: true,
        }).map((plugin) => ({
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
        const payload = {
          ...(cached?.payload ?? {}),
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
          operationalPlan,
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
          runtimeProjectionState: {
            stale: runtimeSnapshot.stale,
            persisted: runtimeSnapshot.persisted,
          },
          operationalView: readiness.operationalView,
          controllerReady: readiness,
        };
        const cachedPayload = cached?.payload;
        const cachedProjectionIncomplete = !cachedPayload
          || typeof cachedPayload !== 'object'
          || !('repoId' in cachedPayload)
          || !('runtimeProjectionState' in cachedPayload)
          || !('operationalView' in cachedPayload)
          || !('controllerReady' in cachedPayload);
        let projectionRecord = cached;
        if (
          !cached
          || cachedProjectionIncomplete
          || !Number.isFinite(projectionAgeMs)
          || projectionAgeMs >= CONTROLLER_CONTEXT_PROJECTION_REFRESH_MS
        ) {
          try {
            projectionRecord = writeControllerContextProjection(ctx.controllerHome, repository.repoId, payload, {
              sourceRevision: contextSourceRevision,
              contentFingerprint: runtimeProjection.metadata?.contentFingerprint,
            });
          } catch {
            projectionRecord = cached;
          }
        }
        const refreshedProjectionAgeMs = controllerContextProjectionAgeMs(projectionRecord);
        return result({
          ...payload,
          contextProjection: {
            generatedAt: projectionRecord?.generatedAt,
            ageMs: Number.isFinite(refreshedProjectionAgeMs) ? refreshedProjectionAgeMs : undefined,
            stale: runtimeSnapshot.stale || controllerContextProjectionNeedsRefresh(projectionRecord, contextSourceRevision),
            healthImpact: false,
            sourceRevision: projectionRecord?.sourceRevision,
            strategy: 'event-driven',
            refreshJobId: undefined,
            readOnly: true,
            nonBlocking: true,
          },
        });
      }
      case 'get_job': {
        const jobId = String(args.job_id ?? '').trim();
        let job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
        if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId || 'missing job_id', errorClass: 'not_found', summary: '未找到对应 Job。' } }, true);
        let timedOut = false;
        let waitedMs = 0;
        if (args.wait === true || typeof args.wait_ms === 'number') {
          const waited = await waitForExecutionJob({
            controllerHome: ctx.controllerHome,
            repoId: job.repoId,
            jobId: job.jobId,
            timeoutMs: typeof args.wait_ms === 'number' ? args.wait_ms : 15_000,
          });
          job = waited.job;
          timedOut = waited.timedOut;
          waitedMs = waited.waitedMs;
        }
        const full = args.detail_level === 'full';
        const repoRoot = repositoryRootForRepoId(ctx.controllerHome, job.repoId);
        // summarizeExecutionJob already embeds a compact digest + single suggestedNextActions list.
        const jobSummary = summarizeExecutionJob(job, repoRoot);
        return result({
          detailLevel: 'summary',
          requestedDetailLevel: full ? 'full' : 'summary',
          job: jobSummary,
          summary: jobSummary.summary,
          phase: jobSummary.phase,
          statusLabel: jobSummary.statusLabel,
          errorClass: jobSummary.errorClass,
          errorMessage: jobSummary.errorMessage,
          changedFiles: jobSummary.changedFiles,
          suggestedNextActions: jobSummary.suggestedNextActions,
          artifactRefs: jobSummary.artifactRefs,
          evidenceIds: jobSummary.evidenceIds,
          evidenceRefs: jobSummary.evidenceRefs,
          waited: args.wait === true || typeof args.wait_ms === 'number',
          timedOut,
          waitedMs,
          ...(args.include_events === true
            ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) }
            : {}),
          next: full
            ? 'Raw job state is intentionally not returned through MCP. Use the bounded job summary, events, and get_artifact with artifactId (ART-...), not evidenceId (EVD-...).'
            : jobSummary.terminal
              ? String(jobSummary.summary ?? '')
              : 'Job is still active. Poll get_job without waiting, or use work_wait only when blocking is explicitly required.',
        }, jobSummary.phase === 'failed' || jobSummary.phase === 'timed_out');
      }
      case 'repository_change_verify': {
        const repository = selected(ctx, args);
        const expectedFileShas = args.expected_file_shas && typeof args.expected_file_shas === 'object' && !Array.isArray(args.expected_file_shas)
          ? Object.fromEntries(
            Object.entries(args.expected_file_shas as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
          : undefined;
        const payload = repositoryChangeVerify({
          repo: repository.canonicalRoot,
          expectedBranch: typeof args.expected_branch === 'string' ? args.expected_branch : undefined,
          expectedHead: typeof args.expected_head === 'string' ? args.expected_head : undefined,
          expectedFileShas,
          patch: typeof args.patch === 'string' ? args.patch : undefined,
          allowedPaths: Array.isArray(args.allowed_paths)
            ? args.allowed_paths.filter((value): value is string => typeof value === 'string')
            : undefined,
          checks: Array.isArray(args.checks)
            ? args.checks.filter((value): value is string => typeof value === 'string')
            : undefined,
          checkTimeoutMs: typeof args.check_timeout_ms === 'number' ? args.check_timeout_ms : undefined,
        });
        return result(payload as unknown as Record<string, unknown>, payload.status === 'failed');
      }
      case 'controller_restart_verify': {
        const payload = await controllerRestartVerify({
          repo: selected(ctx, args).canonicalRoot,
          controllerHome: ctx.controllerHome,
          requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          pollOnly: args.poll_only === true,
          mode: args.mode === 'sync' || args.mode === 'detached' || args.mode === 'auto' ? args.mode : 'auto',
          expectedSourceCommit: typeof args.expected_source_commit === 'string' ? args.expected_source_commit : undefined,
          expectedToolFingerprint: typeof args.expected_tool_fingerprint === 'string' ? args.expected_tool_fingerprint : undefined,
        });
        return result(payload as unknown as Record<string, unknown>, payload.status === 'failed');
      }
      case 'controller_feature_verify': {
        const payload = controllerFeatureVerify({
          repo: selected(ctx, args).canonicalRoot,
          skipLifecycle: args.skip_lifecycle === true,
        });
        return result(payload as unknown as Record<string, unknown>, payload.status === 'failed');
      }
      case 'controller_rollout': {
        const payload = await controllerRollout({
          repo: selected(ctx, args).canonicalRoot,
          controllerHome: ctx.controllerHome,
          skipDurableJob: args.skip_durable_job === true,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        });
        return result(payload as unknown as Record<string, unknown>, payload.status === 'failed');
      }
      case 'controller_rollback': {
        const payload = await controllerRollback({
          repo: selected(ctx, args).canonicalRoot,
          controllerHome: ctx.controllerHome,
          skipDurableJob: args.skip_durable_job === true,
        });
        return result(payload as unknown as Record<string, unknown>, payload.status === 'failed');
      }
      case 'get_artifact': {
        const artifactId = String(args.artifact_id ?? '').trim();
        const artifactRepoId = String(args.repo_id ?? '').trim();
        if (artifactId.startsWith('EVD-')) {
          const evidence = readExecutionEvidence(ctx.controllerHome, artifactRepoId, artifactId);
          return result({
            referenceType: 'evidence',
            evidenceId: evidence.evidenceId,
            repoId: evidence.repoId,
            jobId: evidence.jobId,
            outcome: evidence.outcome,
            operation: evidence.operation,
            revision: evidence.revision,
            executedAt: evidence.executedAt,
            note: 'This is an evidenceId (EVD-...), not an artifactId (ART-...). Evidence holds audit metadata; command output lives under artifactRefs/artifactId.',
            next: `For output content, call get_job with job_id=${evidence.jobId} and use artifactRefs.artifactId, then get_artifact with that ART-... id.`,
          });
        }
        if (!artifactId.startsWith('ART-') && artifactId) {
          return result({
            error: {
              code: 'ARTIFACT_ID_EXPECTED',
              message: `Expected artifactId starting with ART- (got ${artifactId.slice(0, 40)}). evidenceId (EVD-...) is audit metadata; use get_job artifactRefs for content.`,
            },
            referenceType: 'unknown',
            next: 'Call get_job, read artifactRefs[].artifactId (ART-...), then get_artifact with that id and repo_id.',
          }, true);
        }
        const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : 64 * 1024;
        const loaded = readExecutionArtifact(ctx.controllerHome, artifactRepoId, artifactId, maxBytes);
        // Do not re-attach controller/repository/runtime envelopes here; multi-repo layer already compact.
        return result({
          referenceType: 'artifact',
          artifactId: loaded.artifact.artifactId,
          artifactKind: loaded.artifact.kind,
          repoId: loaded.artifact.repoId,
          jobId: loaded.artifact.jobId,
          byteLength: loaded.artifact.byteLength,
          mediaType: loaded.artifact.mediaType,
          truncated: loaded.truncated,
          content: loaded.content,
          next: loaded.truncated
            ? `Artifact truncated at ${maxBytes} bytes. Re-call get_artifact with a larger max_bytes (up to 512KB) or page via result refs.`
            : 'Artifact content loaded.',
        });
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
        const readiness = await controllerReadiness(ctx, repository);
        const toolset = await import('../../../cli/mcp/toolset');
        const exposure = toolset.controllerExposureSnapshot(ctx);
        const localRegisteredToolNames = toolset.allControllerToolDefinitions(ctx).map((tool) => tool.name).sort();
        const toolSurfaceReady = exposure.ready && exposure.missingToolNames.length === 0;
        const stableHome = resolveStableControllerHome(ctx.controllerHome);
        const supervisorState = readSupervisorState(stableHome);
        const stableSupervisorPresent = Boolean(supervisorState) || isStableSupervisorInstalled(stableHome);
        const supervisorServiceCoherence = stableSupervisorPresent
          ? readSupervisorServiceReleaseCoherence(stableHome, supervisorState)
          : { ok: true, serviceRegistered: false, failures: [], expected: undefined, running: undefined, generated: undefined, installed: undefined };
        // Stable ingress health: separate from the daemon-based readiness.
        // A Supervisor that looks healthy internally can still have an
        // unreachable ingress that makes the public Connector 502.
        const ingressState = supervisorState?.ingress;
        const ingressHealthy = Boolean(
          ingressState?.state === 'running'
          && ingressState.pid
          && (ingressState.consecutiveFailures ?? 0) === 0,
        );
        const ingressLocalReady = Boolean(
          ingressHealthy
          && ingressState?.activeUpstreamSlot
          && ingressState?.activeUpstreamPort,
        );
        // External / public endpoint probe: if configured, a repeated failure
        // means the Stable Connector is unreachable even when localhost passes.
        const publicHealthEndpoint = process.env.REPO_HARNESS_SUPERVISOR_PUBLIC_HEALTH_ENDPOINT?.trim();
        const externalEndpointStatus: 'healthy' | 'unhealthy' | 'unknown' = publicHealthEndpoint
          ? (supervisorState?.externalEndpointHealthy === true ? 'healthy' : 'unhealthy')
          : 'unknown';
        const externalEndpointLastChecked = supervisorState?.externalEndpointLastCheckedAt;
        const externalEndpointDetail = supervisorState?.externalEndpointLastDetail;
        const stableIngressReady = ingressLocalReady && (externalEndpointStatus !== 'unhealthy');
        const effectiveReady = readiness.ready && toolSurfaceReady && supervisorServiceCoherence.ok && (stableSupervisorPresent ? stableIngressReady : true);
        const taskLedger = repository ? buildControllerTaskLedgerProjection(repository.canonicalRoot) : undefined;
        const agentExecutors = readAgentExecutableReadinessSnapshot(ctx.controllerHome);
        return result({
          ready: effectiveReady,
          state: effectiveReady ? readiness.state : 'degraded',
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
          health: readiness.health,
          operationalView: readiness.operationalView,
          daemon: readiness.daemon,
          durableScheduler: readiness.durableScheduler,
          workerLoop: readiness.workerLoop,
          localBridge: readiness.localBridge,
          agentExecutors: agentExecutors
            ? { status: 'probed', ...agentExecutors }
            : { status: 'not_probed', executors: {} },
          stableSupervisor: stableSupervisorPresent ? {
            ready: supervisorServiceCoherence.ok,
            loaded: true,
            pid: supervisorState?.supervisor.pid,
            healthy: supervisorState?.observedState === 'healthy',
            expectedReleaseRevision: supervisorServiceCoherence.expected?.releaseRevision,
            runningReleaseRevision: supervisorServiceCoherence.running?.releaseRevision,
            generatedServiceReleaseRevision: supervisorServiceCoherence.generated?.releaseRevision,
            installedServiceReleaseRevision: supervisorServiceCoherence.installed?.releaseRevision,
            failures: supervisorServiceCoherence.failures,
          } : { ready: true, installed: false, loaded: false, failures: [] },
          stableIngress: {
            pid: ingressState?.pid,
            localReady: ingressLocalReady,
            state: ingressState?.state ?? (stableSupervisorPresent ? 'unknown' : 'not_applicable'),
            consecutiveFailures: ingressState?.consecutiveFailures ?? 0,
          },
          externalEndpoint: {
            status: externalEndpointStatus,
            lastCheckedAt: externalEndpointLastChecked,
            detail: externalEndpointDetail,
          },
          reasons: [
            ...readiness.reasons,
            ...(!toolSurfaceReady ? [{ code: 'MCP_TOOL_SURFACE_INCOMPLETE', message: 'Registered and exposed MCP tool schemas do not match.' }] : []),
            ...(!supervisorServiceCoherence.ok ? [{ code: 'SUPERVISOR_SERVICE_RELEASE_DRIFT', message: supervisorServiceCoherence.failures.join('; ') }] : []),
            ...(stableSupervisorPresent && !ingressLocalReady ? [{ code: 'STABLE_INGRESS_NOT_READY', message: 'Stable ingress is not serving traffic or has accumulated health failures.' }] : []),
            ...(externalEndpointStatus === 'unhealthy' ? [{ code: 'PUBLIC_STABLE_ENDPOINT_UNHEALTHY', message: externalEndpointDetail ?? 'Public stable endpoint is unreachable even though localhost checks pass.' }] : []),
          ],
          toolSurface: {
            ready: toolSurfaceReady,
            localExpectedTools: exposure.expectedToolNames,
            localRegisteredTools: localRegisteredToolNames,
            connectorExposedTools: exposure.actualToolNames,
            currentCallableTools: exposure.actualToolNames,
            expectedTools: exposure.expectedToolNames,
            actualTools: exposure.actualToolNames,
            missingTools: exposure.missingToolNames,
            unexpectedTools: exposure.unexpectedToolNames,
            duplicateTools: exposure.duplicateToolNames,
            fingerprint: exposure.fingerprint,
            schemaStableAcrossAccessModes: true,
          },
          access: exposure.access,
          registeredRepositories: registered.length,
          ...(repository ? { repository: summarizeRuntimeProjectionForReadiness(readiness.projection ?? readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId).projection) } : {}),
        });
      }
      case 'repository_runtime_snapshot': {
        const repository = selected(ctx, args);
        const snapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
        return result({
          snapshot: summarizeRuntimeProjectionForReadiness(snapshot.projection),
          stale: snapshot.stale,
          persisted: snapshot.persisted,
          dirtySinceAt: snapshot.dirtySinceAt,
          dirtyReason: snapshot.dirtyReason,
        });
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
        const snapshot = await capabilityRecoverySnapshot(ctx, repository, args);
        return result({ recovery: snapshot, audit: listRecoveryAuditRecords(ctx.controllerHome, repository.repoId, 10) });
      }
      case 'capability_recovery_plan': {
        const repository = selected(ctx, args);
        const snapshot = await capabilityRecoverySnapshot(ctx, repository, args);
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
        const recovery = await capabilityRecoverySnapshot(ctx, repository, { ...args, recent_errors: recentErrors });
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
      case 'goal_create':
      case 'goal_list':
      case 'goal_get':
      case 'goal_start':
      case 'goal_continue':
      case 'goal_stop':
      case 'goal_finalize':
      case 'goal_status':
      case 'goal_tick_once':
      case 'goal_handoff_packet_create':
      case 'goal_handoff_packet_get':
      case 'provider_list':
      case 'provider_health':
      case 'provider_config_status':
      case 'executor_route_preview':
      case 'executor_dispatch':
      case 'repair_plan':
      case 'repair_continue': {
        const repository = selected(ctx, args);
        const goalCtx: GoalLoopContext = {
          goalStore: { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          packetStore: { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          repoId: repository.repoId,
        };
        const goalId = typeof args.goal_id === 'string' ? args.goal_id : '';
        const taskIntent = typeof args.task_intent === 'string' ? args.task_intent as TaskIntent : undefined;
        switch (name) {
          case 'goal_create': {
            const goal = goalCreate(goalCtx, {
              title: String(args.title ?? ''),
              objective: String(args.objective ?? ''),
              mode: args.mode === 'manual' || args.mode === 'supervised' || args.mode === 'autonomous' ? args.mode : 'autonomous',
              issueId: typeof args.issue_id === 'string' ? args.issue_id : undefined,
              taskIds: Array.isArray(args.task_ids) ? args.task_ids.map(String) : undefined,
              acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
              checkIds: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
              allowedExecutors: Array.isArray(args.allowed_executors) ? args.allowed_executors.map(String) : undefined,
              forbiddenExecutors: Array.isArray(args.forbidden_executors) ? args.forbidden_executors.map(String) : undefined,
              retryBudget: typeof args.retry_budget === 'number' ? args.retry_budget : undefined,
            });
            return result({ goal, summary: summarizeGoalPublic(goal) });
          }
          case 'goal_list': {
            const status = typeof args.status === 'string' ? args.status as GoalStatus | 'active' | 'all' : 'active';
            const goals = goalList(goalCtx, status, typeof args.limit === 'number' ? args.limit : 50);
            return result({ goals: goals.map(summarizeGoalPublic), count: goals.length });
          }
          case 'goal_get': {
            const goal = goalGet(goalCtx, goalId);
            if (!goal) return result({ error: { code: 'GOAL_NOT_FOUND', message: `Goal not found: ${goalId}` } }, true);
            return result({ goal, summary: summarizeGoalPublic(goal) });
          }
          case 'goal_start':
            return result({ tick: goalStart(goalCtx, goalId) });
          case 'goal_continue':
            return result({ tick: goalContinue(goalCtx, goalId) });
          case 'goal_stop':
            return result({ goal: summarizeGoalPublic(goalStop(goalCtx, goalId, typeof args.reason === 'string' ? args.reason : undefined)) });
          case 'goal_finalize': {
            const finalized = goalFinalize(goalCtx, goalId, { force: args.force === true });
            return result({ ok: finalized.ok, reason: finalized.reason, goal: summarizeGoalPublic(finalized.goal) }, !finalized.ok);
          }
          case 'goal_status':
            return result(goalStatus(goalCtx, goalId || undefined));
          case 'goal_tick_once': {
            if (goalId) {
              return result({
                tick: goalTickOnce(goalCtx, goalId, {
                  taskIntent,
                  providerFailure: args.provider_failure === true,
                  externalWrite: args.external_write === true,
                  approvalConfirmed: args.approval_confirmed === true,
                  verificationResult: typeof args.verification_check_id === 'string'
                    ? {
                        checkId: args.verification_check_id,
                        ok: args.verification_ok === true,
                      }
                    : undefined,
                }),
              });
            }
            return result({ ticks: tickActiveGoals(goalCtx) });
          }
          case 'goal_handoff_packet_create':
            return result({
              packet: goalHandoffPacketCreate(goalCtx, goalId, {
                blockers: Array.isArray(args.blockers) ? args.blockers.map(String) : undefined,
                requiredUserDecision: typeof args.required_user_decision === 'string' ? args.required_user_decision : undefined,
                recommendedProvider: typeof args.recommended_provider === 'string' ? args.recommended_provider : undefined,
              }),
            });
          case 'goal_handoff_packet_get': {
            const packet = goalHandoffPacketGet(goalCtx, String(args.packet_id ?? ''));
            if (!packet) return result({ error: { code: 'PACKET_NOT_FOUND', message: 'Handoff packet not found.' } }, true);
            return result({ packet });
          }
          case 'provider_list':
            return result({ providers: providerListAction(goalCtx), policyOwner: 'repo-harness' });
          case 'provider_health':
            return result({
              health: providerHealthAction(goalCtx, typeof args.provider_id === 'string' ? args.provider_id : undefined),
              redacted: true,
            });
          case 'provider_config_status':
            return result(providerConfigStatusAction(goalCtx));
          case 'executor_route_preview':
            return result({
              route: executorRoutePreview(goalCtx, {
                goalId: goalId || undefined,
                taskIntent,
                risk: typeof args.risk === 'string' ? args.risk as 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive' | 'raw_secret_config' : undefined,
                objective: typeof args.objective === 'string' ? args.objective : undefined,
              }),
            });
          case 'executor_dispatch':
            return result(executorDispatch(goalCtx, {
              goalId,
              providerId: typeof args.provider_id === 'string' ? args.provider_id : undefined,
              taskIntent,
              risk: typeof args.risk === 'string' ? args.risk as 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive' | 'raw_secret_config' : undefined,
              approvalConfirmed: args.approval_confirmed === true,
              externalWrite: args.external_write === true,
              strongConfirmationText: typeof args.strong_confirmation_text === 'string' ? args.strong_confirmation_text : undefined,
            }));
          case 'repair_plan':
            return result(repairPlan(goalCtx, goalId));
          case 'repair_continue':
            return result({
              tick: repairContinue(goalCtx, goalId, {
                forceFailureClass: typeof args.force_failure_class === 'string'
                  ? args.force_failure_class as import('../../control-plane/goal-loop').FailureClass
                  : undefined,
              }),
            });
          default:
            return result({ error: { code: 'GOAL_LOOP_UNKNOWN', message: name } }, true);
        }
      }
      case 'workspace_auth_status': {
        const repository = selected(ctx, args);
        return result(buildWorkspaceAuthStatus(listAssistantPluginManifests(ctx.controllerHome, repository)));
      }
      case 'workspace_auth_login_prepare': {
        selected(ctx, args);
        return result(prepareWorkspaceAuthLogin(ctx.controllerHome, {
          service: typeof args.service === 'string' ? args.service : undefined,
          scopes: Array.isArray(args.scopes) ? args.scopes.map(String) : undefined,
          redirectUri: typeof args.redirect_uri === 'string' ? args.redirect_uri : undefined,
        }));
      }
      case 'assistant_model_readiness': {
        return result(assistantModelReadiness());
      }
      case 'assistant_standing_grants': {
        const repository = selected(ctx, args);
        return result(listAssistantStandingGrants(ctx.controllerHome, repository, {
          status: typeof args.status === 'string' ? args.status as any : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }));
      }
      case 'assistant_standing_grant_create': {
        const repository = selected(ctx, args);
        return result({ grant: createAssistantStandingGrant(ctx.controllerHome, repository, {
          name: typeof args.name === 'string' ? args.name : undefined,
          pluginId: String(args.plugin_id ?? '').trim(),
          actionId: String(args.action_id ?? '').trim(),
          routineIds: Array.isArray(args.routine_ids) ? args.routine_ids.map(String) : undefined,
          senderAllowlist: Array.isArray(args.sender_allowlist) ? args.sender_allowlist.map(String) : undefined,
          subjectContains: Array.isArray(args.subject_contains) ? args.subject_contains.map(String) : undefined,
          minConfidence: typeof args.min_confidence === 'number' ? args.min_confidence : undefined,
          maxPerRun: typeof args.max_per_run === 'number' ? args.max_per_run : undefined,
          expiresInDays: typeof args.expires_in_days === 'number' ? args.expires_in_days : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          origin: { surface: 'mcp', actor: 'assistant_standing_grant_create' },
        }) });
      }
      case 'assistant_standing_grant_revoke': {
        const repository = selected(ctx, args);
        return result({ grant: revokeAssistantStandingGrant(ctx.controllerHome, repository, {
          grantId: String(args.grant_id ?? '').trim(),
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          origin: { surface: 'mcp', actor: 'assistant_standing_grant_revoke' },
        }) });
      }
      case 'assistant_action_proposals': {
        const repository = selected(ctx, args);
        const proposalId = typeof args.proposal_id === 'string' ? args.proposal_id.trim() : '';
        return result(proposalId
          ? { proposal: getAssistantActionProposal(ctx.controllerHome, repository, proposalId) }
          : listAssistantActionProposals(ctx.controllerHome, repository, {
              status: typeof args.status === 'string' ? args.status as any : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
            }));
      }
      case 'assistant_action_proposal_resolve': {
        const repository = selected(ctx, args);
        const proposalId = String(args.proposal_id ?? '').trim();
        if (args.decision === 'reject') {
          return result({ proposal: rejectAssistantActionProposal(ctx.controllerHome, repository, proposalId, typeof args.reason === 'string' ? args.reason : undefined) });
        }
        if (args.confirm_authorization !== true) throw new Error('ASSISTANT_ACTION_APPROVAL_REQUIRED: confirm_authorization=true');
        const requestId = String(args.request_id ?? `assistant-proposal:${proposalId}`).trim();
        return result({ proposal: approveAssistantActionProposal(ctx.controllerHome, repository, {
          proposalId,
          requestId,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
          origin: { surface: 'mcp', actor: 'assistant_action_proposal_resolve' },
        }) });
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
            payload = { recovery: await capabilityRecoverySnapshot(ctx, repository, args) };
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
          case 'recovery.restart_controller':
          case 'recovery.restart_local_bridge': {
            const requestId = typeof args.request_id === 'string' && args.request_id.trim()
              ? args.request_id.trim()
              : `capability-recovery-${action.id}-${Date.now()}`;
            const kind: SupervisorOperationKind = action.id === 'recovery.restart_local_bridge'
              ? 'restart_gateway'
              : 'restart_controller';
            const supervisorRestart = await stableSupervisorFacadeMutation({
              controllerHome: ctx.controllerHome,
              requestId,
              kind,
              actor: 'capability_recovery_apply',
              reason,
            });
            if (supervisorRestart.installed) {
              if (!supervisorRestart.accepted || !supervisorRestart.operation) {
                throw new Error(supervisorRestart.error ?? 'SUPERVISOR_OPERATION_REJECTED');
              }
              payload = {
                runtimeSupervisor: supervisorRestart,
                note: kind === 'restart_controller'
                  ? 'The Stable Supervisor owns a controller-only restart and preserves the Gateway unless generation reconciliation requires a refresh.'
                  : 'The Stable Supervisor owns the Gateway/embedded Local Controller restart. The request returns with a reconnect-safe operation ID.',
              };
              affectedPaths = ['_ops/controller-home/supervisor/operations'];
              break;
            }
            const restart = scheduleControllerServiceRestart({
              repo: repository.canonicalRoot,
              controllerHome: ctx.controllerHome,
              requestId,
              requestedBy: 'capability_recovery_apply',
              reason,
              mode: 'detached',
            });
            payload = {
              restart,
              note: 'Stable Supervisor is not installed; the legacy detached coordinator owns the full Controller stack restart.',
            };
            affectedPaths = ['_ops/controller-home/restart'];
            break;
          }
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
        const controllerRepository = controllerPluginRepository(ctx.controllerHome);
        const controllerPlugins = listAssistantPluginManifests(ctx.controllerHome, controllerRepository, {
          preferStored: true,
        }).map(summarizePlugin);
        let repositoryPlugins: ReturnType<typeof summarizePlugin>[] = [];
        let repositoryId: string | undefined;
        try {
          const repository = selected(ctx, args);
          repositoryId = repository.repoId;
          repositoryPlugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
            preferStored: true,
          }).map(summarizePlugin);
        } catch (error) {
          if (typeof args.repo_id === 'string' && args.repo_id.trim()) throw error;
        }
        return result({
          scope: repositoryPlugins.length > 0 ? 'combined' : 'controller',
          repositoryId,
          plugins: [...repositoryPlugins, ...controllerPlugins]
            .sort((left, right) => String(left.pluginId).localeCompare(String(right.pluginId))),
        });
      }
      case 'get_plugin': {
        const pluginId = String(args.plugin_id ?? '').trim();
        const repository = pluginId === 'local_system'
          ? controllerPluginRepository(ctx.controllerHome)
          : selected(ctx, args);
        return result({
          scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
          plugin: summarizePlugin(getAssistantPluginManifest(ctx.controllerHome, repository, pluginId)),
        });
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
        const pluginId = String(args.plugin_id ?? '').trim();
        const repository = pluginId === 'local_system'
          ? controllerPluginRepository(ctx.controllerHome)
          : selected(ctx, args);
        const actionId = String(args.action_id ?? '').trim();
        const requestId = String(args.request_id ?? '').trim();
        const actionArguments = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {};
        const request = {
          pluginId,
          actionId,
          requestId,
          args: actionArguments,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
          origin: { surface: 'mcp' as const, actor: 'plugin_action_execute', correlationId: requestId },
        };
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, pluginId);
        const action = manifest.actions.find((entry) => entry.actionId === actionId);
        if (action && isDirectPluginReadAction(action)) {
          const direct = await executeAssistantPluginReadDirect(ctx.controllerHome, repository, request);
          return result({
            accepted: true,
            direct: true,
            durable: false,
            plugin: summarizePlugin(direct.manifest),
            action: {
              actionId: direct.action.actionId,
              risk: direct.action.risk,
              confirmation: direct.action.confirmation,
            },
            scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
            result: direct.result,
            next: 'Continue with the returned bounded result; no Job polling is required.',
          });
        }
        const submitted = submitAssistantPluginAction(ctx.controllerHome, repository, request);
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
          scope: repository.repoId === '__controller__' ? 'controller' : 'repository',
          job: summarizeWork(submitted.job, repository.canonicalRoot),
          daemon: { status: daemon.status, pid: daemon.pid },
          next: `Call get_job with job_id ${submitted.job.jobId}.`,
        });
      }
      case 'toolchain_plugin_summary': {
        const pluginId = String(args.plugin_id ?? '').trim();
        const repository = pluginId === 'local_system'
          ? controllerPluginRepository(ctx.controllerHome)
          : selected(ctx, args);
        const manifest = getAssistantPluginManifest(ctx.controllerHome, repository, pluginId);
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
        let job: ExecutionJob | undefined;
        try { job = getExecutionJob(ctx.controllerHome, repository.repoId, workRef); }
        catch { job = undefined; }
        const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot);
        if (job) {
          return result({
            digest: summarizeJobResultForLowInterception(job),
            workRef,
            taskLedgerStatus: taskLedger.status,
            next: taskLedger.status.nextAction,
          });
        }
        const process = getProcessHandle(ctx.controllerHome, repository.repoId, workRef);
        if (!process) return result({ error: { code: 'WORK_NOT_FOUND', message: 'No Work or managed process matched work_ref.', errorClass: 'not_found', summary: '未找到对应任务。' } }, true);
        const digest = managedProcessOperationDigest(process);
        return result({
          digest,
          workRef,
          taskLedgerStatus: taskLedger.status,
          next: process.completed === true
            ? 'Managed process is terminal; inspect the bounded digest above.'
            : `Poll work_status_digest with work_ref ${workRef}; do not re-run the original operation.`,
        }, digest.phase === 'failed' || digest.phase === 'timed_out');
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
        // Validate supervisor policy before allocating a Git worktree. Invalid
        // recursive or external-effect operations must leave no workspace behind.
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
        if (supervisorMode === 'operation' && !supervisorOperation) throw new Error('CAMPAIGN_SUPERVISOR_OPERATION_REQUIRED');
        if (supervisorMode === 'workspace_agent' && !workspaceAgentId) throw new Error('CAMPAIGN_WORKSPACE_AGENT_ID_REQUIRED');

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
        const requestId = String(args.request_id ?? '');
        setCampaignStatus(ctx.controllerHome, repository.repoId, current.campaignId, requestId, 'completed', 'Accepted by human.', expectedRevision(args));
        return result({ campaign: completeCampaignWorkspace(ctx.controllerHome, repository.repoId, current.campaignId, requestId) });
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
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
