import type { TaskRisk } from './types';

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
  risk?: TaskRisk;
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

  const protectedPathTouched = paths.some((path) => PROTECTED_PATH.test(path));
  const durableComplex =
    input.requiresParallelism === true ||
    input.requiresLongRunningChecks === true ||
    input.needsDependencies === true ||
    risk === 'high' ||
    risk === 'destructive' ||
    expectedFiles > 12 ||
    expectedChangedLines > 2000 ||
    protectedPathTouched;

  if (durableComplex) {
    if (input.requiresParallelism) reasons.push('The work needs independent parallel Tasks.');
    if (input.requiresLongRunningChecks) reasons.push('The work has long-running verification or environment dependencies.');
    if (input.needsDependencies) reasons.push('The work needs a durable dependency graph.');
    if (risk === 'high') reasons.push('The declared risk is high.');
    if (risk === 'destructive') reasons.push('The request contains destructive or irreversible operations.');
    if (expectedFiles > 12 || expectedChangedLines > 2000) reasons.push('The estimated change is too broad for one bounded edit session.');
    if (protectedPathTouched) reasons.push('The request touches a protected or release-sensitive path.');
    return {
      recommendedMode: 'issue_task',
      confidence: 'high',
      reasons,
      nextTools: ['inspect_issue_readiness', 'create_issue or append_task', 'dispatch_task', 'verify_task', 'accept_task'],
      issueRequired: true,
    };
  }

  const discoveryRequired = input.requiresInvestigation === true || paths.length === 0;
  const direct =
    risk !== 'high' &&
    risk !== 'destructive' &&
    paths.length <= 8 &&
    expectedFiles <= 8 &&
    expectedChangedLines <= 1000;

  if (direct) {
    if (discoveryRequired) {
      reasons.push('The exact edit locations can be discovered with repository search before opening a bounded edit session.');
      reasons.push('Investigation alone does not require an Agent when the expected change remains bounded.');
    } else {
      reasons.push('The target files are known and the change is bounded.');
    }
    if (expectedChangedLines > 0) reasons.push(`The estimated change is ${expectedChangedLines} lines across ${Math.max(expectedFiles, paths.length)} file(s).`);
    return {
      recommendedMode: 'direct_edit',
      confidence: discoveryRequired ? 'medium' : 'high',
      reasons,
      nextTools: [
        ...(discoveryRequired ? ['search_repository'] : []),
        'read_repository_file',
        'begin_edit_session',
        'apply_patch',
        'get_edit_session_diff',
        'verify_edit_session',
        'finalize_edit_session',
      ],
      issueRequired: false,
    };
  }

  reasons.push('The request is larger than one preferred direct-edit session but does not need a durable Issue graph.');
  reasons.push('Use one scoped Agent session only after repository search shows that bounded direct patches are not safe or practical.');
  return {
    recommendedMode: 'quick_agent',
    confidence: 'medium',
    reasons,
    nextTools: ['search_repository', 'submit_local_job(action=quick-agent-session)', 'get_task_run', 'get_task_diff'],
    issueRequired: false,
  };
}
