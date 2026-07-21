import type { TaskRisk } from './types';

export type WorkMode = 'direct_edit' | 'quick_agent' | 'issue_task' | 'campaign';
export type ExecutionPathPreference = 'fast' | 'durable' | 'campaign';

export interface WorkModeAssessmentInput {
  description: string;
  knownPaths?: string[];
  expectedFiles?: number;
  expectedChangedLines?: number;
  requiresInvestigation?: boolean;
  requiresParallelism?: boolean;
  requiresLongRunningChecks?: boolean;
  needsDependencies?: boolean;
  /** Explicit multi-delivery program with independent long-running workstreams. */
  requiresIndependentDeliverables?: boolean;
  independentTaskCount?: number;
  risk?: TaskRisk;
  /** True when caller already knows remote/deploy/publish is required. */
  requiresRemoteWrite?: boolean;
  /** True when interruption recovery / worker isolation is required. */
  requiresRecovery?: boolean;
  requiresWorkerIsolation?: boolean;
}

export interface WorkModeAssessment {
  recommendedMode: WorkMode;
  /** Thin Harness / Gateway path preference derived from the same decision. */
  executionPath: ExecutionPathPreference;
  confidence: 'high' | 'medium';
  reasons: string[];
  nextTools: string[];
  issueRequired: boolean;
  campaignRequired: boolean;
}

const PROTECTED_PATH = /(^|\/)(\.github|\.git|package-lock\.json|bun\.lock|pnpm-lock\.yaml|yarn\.lock|.*\.xcodeproj|.*\.xcworkspace)(\/|$)/;

/**
 * Choose how ChatGPT should execute ordinary repository work.
 *
 * Defaults:
 * - small bounded multi-file edits stay direct_edit / Fast Path
 * - multi-file alone never upgrades to Issue/Task/Campaign
 * - Campaign is opt-in for multiple independent long-running deliverables
 */
export function assessWorkMode(input: WorkModeAssessmentInput): WorkModeAssessment {
  const description = input.description.trim();
  if (!description) throw new Error('work description is required');
  const paths = Array.from(new Set((input.knownPaths ?? []).map((path) => path.trim()).filter(Boolean)));
  const expectedFiles = Math.max(0, Math.trunc(input.expectedFiles ?? paths.length));
  const expectedChangedLines = Math.max(0, Math.trunc(input.expectedChangedLines ?? 0));
  const independentTaskCount = Math.max(0, Math.trunc(input.independentTaskCount ?? 0));
  const risk = input.risk ?? 'low';
  const reasons: string[] = [];

  const protectedPathTouched = paths.some((path) => PROTECTED_PATH.test(path));
  const campaignEligible =
    input.requiresIndependentDeliverables === true
    || (input.requiresParallelism === true && independentTaskCount >= 2)
    || independentTaskCount >= 3;

  if (campaignEligible) {
    if (input.requiresIndependentDeliverables) reasons.push('Multiple independent long-running deliverables were requested.');
    if (input.requiresParallelism) reasons.push('The work needs truly independent parallel delivery lanes.');
    if (independentTaskCount >= 2) reasons.push(`About ${independentTaskCount} independent tasks exceed one Issue/Task slice.`);
    return {
      recommendedMode: 'campaign',
      executionPath: 'campaign',
      confidence: 'high',
      reasons,
      nextTools: ['create_campaign', 'add_campaign_task', 'reconcile_campaign', 'get_campaign_review_packet'],
      issueRequired: false,
      campaignRequired: true,
    };
  }

  const durableComplex =
    input.requiresLongRunningChecks === true ||
    input.needsDependencies === true ||
    input.requiresRemoteWrite === true ||
    input.requiresRecovery === true ||
    input.requiresWorkerIsolation === true ||
    risk === 'high' ||
    risk === 'destructive' ||
    expectedFiles > 12 ||
    expectedChangedLines > 2000 ||
    protectedPathTouched ||
    (input.requiresParallelism === true && independentTaskCount < 2);

  if (durableComplex) {
    if (input.requiresParallelism) reasons.push('Parallel work is requested but not enough independent deliverables for a Campaign; use Issue/Task.');
    if (input.requiresLongRunningChecks) reasons.push('The work has long-running verification or environment dependencies.');
    if (input.needsDependencies) reasons.push('The work needs a durable dependency graph.');
    if (input.requiresRemoteWrite) reasons.push('Remote write, publish, or deploy requires Durable execution.');
    if (input.requiresRecovery) reasons.push('Cross-session recovery requires Durable Work.');
    if (input.requiresWorkerIsolation) reasons.push('Worker isolation / worktree isolation requires Durable Work.');
    if (risk === 'high') reasons.push('The declared risk is high.');
    if (risk === 'destructive') reasons.push('The request contains destructive or irreversible operations.');
    if (expectedFiles > 12 || expectedChangedLines > 2000) reasons.push('The estimated change is too broad for one bounded edit session.');
    if (protectedPathTouched) reasons.push('The request touches a protected or release-sensitive path.');
    return {
      recommendedMode: 'issue_task',
      executionPath: 'durable',
      confidence: 'high',
      reasons,
      nextTools: ['inspect_issue_readiness', 'create_issue or append_task', 'dispatch_task', 'verify_task', 'accept_task'],
      issueRequired: true,
      campaignRequired: false,
    };
  }

  const discoveryRequired = input.requiresInvestigation === true || paths.length === 0;
  // Multi-file alone is not enough to leave direct edit. Prefer batch + focused checks.
  const direct =
    expectedFiles <= 12 &&
    expectedChangedLines <= 1000 &&
    paths.length <= 12;

  if (direct) {
    if (discoveryRequired) {
      reasons.push('The exact edit locations can be discovered with repository search before opening a bounded edit session.');
      reasons.push('Investigation alone does not require an Agent when the expected change remains bounded.');
    } else {
      reasons.push('The target files are known and the change is bounded.');
    }
    if (expectedFiles > 1) {
      reasons.push('Multiple files remain eligible for Direct Edit / repository_workbench batch; do not auto-create Issue/Task/Campaign.');
    }
    if (expectedChangedLines > 0) reasons.push(`The estimated change is ${expectedChangedLines} lines across ${Math.max(expectedFiles, paths.length)} file(s).`);
    return {
      recommendedMode: 'direct_edit',
      executionPath: 'fast',
      confidence: discoveryRequired ? 'medium' : 'high',
      reasons,
      nextTools: [
        ...(discoveryRequired ? ['search_repository', 'repository_workbench(operation=batch_execute reads)'] : []),
        'repository_workbench(operation=batch_execute)',
        'read_repository_file',
        'begin_edit_session',
        'apply_patch',
        'get_edit_session_diff',
        'verify_edit_session',
        'finalize_edit_session',
      ],
      issueRequired: false,
      campaignRequired: false,
    };
  }

  reasons.push('The request is larger than one preferred direct-edit session but does not need a durable Issue graph or Campaign.');
  reasons.push('Use one scoped Agent session only after repository search shows that bounded direct patches are not safe or practical.');
  return {
    recommendedMode: 'quick_agent',
    executionPath: 'durable',
    confidence: 'medium',
    reasons,
    nextTools: ['search_repository', 'submit_local_job(action=quick-agent-session)', 'get_task_run', 'get_task_diff'],
    issueRequired: false,
    campaignRequired: false,
  };
}
