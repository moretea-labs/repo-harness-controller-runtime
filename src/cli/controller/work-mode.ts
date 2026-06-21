export type WorkMode = 'direct_edit' | 'quick_agent' | 'issue_task';

export interface WorkModeAssessmentInput {
  description: string;
  knownPaths?: string[];
  expectedFiles?: number;
  expectedChangedLines?: number;
  requiresInvestigation?: boolean;
  requiresParallelism?: boolean;
  requiresLongRunningChecks?: boolean;
  needsDependencies?: boolean;
  risk?: 'low' | 'medium' | 'high';
}

export interface WorkModeAssessment {
  recommendedMode: WorkMode;
  confidence: 'high' | 'medium';
  reasons: string[];
  nextTools: string[];
  issueRequired: boolean;
}

const PROTECTED_PATH = /(^|\/)(\.github|\.git|package-lock\.json|bun\.lock|pnpm-lock\.yaml|yarn\.lock|.*\.xcodeproj|.*\.xcworkspace)(\/|$)/;

export function assessWorkMode(input: WorkModeAssessmentInput): WorkModeAssessment {
  const description = input.description.trim();
  if (!description) throw new Error('work description is required');
  const paths = Array.from(new Set((input.knownPaths ?? []).map((path) => path.trim()).filter(Boolean)));
  const expectedFiles = Math.max(0, Math.trunc(input.expectedFiles ?? paths.length));
  const expectedChangedLines = Math.max(0, Math.trunc(input.expectedChangedLines ?? 0));
  const risk = input.risk ?? 'low';
  const reasons: string[] = [];

  const complex =
    input.requiresInvestigation === true ||
    input.requiresParallelism === true ||
    input.requiresLongRunningChecks === true ||
    input.needsDependencies === true ||
    risk === 'high' ||
    expectedFiles > 8 ||
    expectedChangedLines > 1200 ||
    paths.some((path) => PROTECTED_PATH.test(path));

  if (complex) {
    if (input.requiresInvestigation) reasons.push('The implementation or root cause is not yet known.');
    if (input.requiresParallelism) reasons.push('The work needs independent parallel Tasks.');
    if (input.requiresLongRunningChecks) reasons.push('The work has long-running verification or environment dependencies.');
    if (input.needsDependencies) reasons.push('The work needs a durable dependency graph.');
    if (risk === 'high') reasons.push('The declared risk is high.');
    if (expectedFiles > 8 || expectedChangedLines > 1200) reasons.push('The estimated change is too broad for one bounded edit session.');
    if (paths.some((path) => PROTECTED_PATH.test(path))) reasons.push('The request touches a protected or release-sensitive path.');
    return {
      recommendedMode: 'issue_task',
      confidence: 'high',
      reasons,
      nextTools: ['inspect_issue_readiness', 'create_issue or append_task', 'dispatch_task', 'verify_task', 'accept_task'],
      issueRequired: true,
    };
  }

  const direct =
    paths.length > 0 &&
    paths.length <= 5 &&
    expectedFiles <= 5 &&
    expectedChangedLines <= 500;

  if (direct) {
    reasons.push('The target files are known and the change is bounded.');
    if (expectedChangedLines > 0) reasons.push(`The estimated change is ${expectedChangedLines} lines across ${Math.max(expectedFiles, paths.length)} file(s).`);
    return {
      recommendedMode: 'direct_edit',
      confidence: 'high',
      reasons,
      nextTools: ['read_repository_file', 'begin_edit_session', 'apply_patch', 'get_edit_session_diff', 'verify_edit_session', 'finalize_edit_session'],
      issueRequired: false,
    };
  }

  reasons.push('The request is bounded, but exact file edits are not yet fully specified.');
  reasons.push('Use one scoped agent session only when direct patch operations cannot be prepared safely.');
  return {
    recommendedMode: 'quick_agent',
    confidence: 'medium',
    reasons,
    nextTools: ['search_repository', 'submit_local_job(action=quick-agent-session)', 'get_task_run', 'get_task_diff'],
    issueRequired: false,
  };
}
