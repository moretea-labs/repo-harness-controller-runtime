import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import {
  FAST_BATCH_MAX_STEPS,
  FAST_PATH_MAX_TIMEOUT_MS,
  type ExecutionDecision,
  type ExecutionRisk,
  type FastOperationKind,
  type RepositoryBatchStep,
} from './types';

export interface RouteExecutionInput {
  operation: FastOperationKind | string;
  mode?: 'auto' | 'fast' | 'durable';
  background?: boolean;
  requiresRecovery?: boolean;
  requiresIsolation?: boolean;
  requiresWorktree?: boolean;
  requiresRetry?: boolean;
  agentRun?: boolean;
  interactionSession?: boolean;
  humanHandoff?: boolean;
  remoteWrite?: boolean;
  concurrentWriteLanes?: boolean;
  timeoutMs?: number;
  command?: string | readonly string[];
  paths?: string[];
  allowedPaths?: string[];
  patchOperationCount?: number;
  /** Paths extracted from patch operations[].path */
  patchPaths?: string[];
  steps?: RepositoryBatchStep[];
  defaultBranch?: string;
}

const FAST_OPERATIONS = new Set<string>([
  'read_file',
  'search',
  'git_status',
  'git_diff',
  'apply_patch',
  'run_short_command',
  'run_focused_check',
  'stage_paths',
  'commit_paths',
  'batch',
  'read_lanes',
  'patch_proposal_validate',
  'patch_proposal_lanes',
  'repository_git_status',
  'repository_git_diff',
  'repository_safe_patch_apply',
  'repository_safe_patch_plan',
  'search_repository',
  'read_file_range',
  'git_diff_paths',
  'git_stage_paths',
  'git_commit_paths',
  'apply_patch',
  'apply_edit_operations',
]);

const DURABLE_OPERATIONS = new Set<string>([
  'run_check',
  'verify_edit_session',
  'dispatch_task',
  'launch_issue',
  'quick_agent_session',
  'publish_issue_to_github',
  'release_gate',
  'runtime_recovery',
  'capability_recovery',
  'repository_git_finish_workflow',
  'repository_git_merge_branch',
  'repository_git_delete_branch',
  'integrate_task_run',
  'ios_app_build',
  'ios_app_install',
  'ios_app_launch',
  'work_finalize',
]);

const DESTRUCTIVE_HINTS = [
  'rm -rf',
  'git reset --hard',
  'git clean -fd',
  'git push --force',
  'drop table',
  'mkfs',
  'dd if=',
];

function riskFromClassification(risk: string): ExecutionRisk {
  if (risk === 'readonly' || risk === 'workspace_write' || risk === 'remote_write' || risk === 'destructive') {
    return risk;
  }
  return 'unknown';
}

/**
 * Strict focused-check gate: typed argv only, explicit file/filter required.
 * Bare package-test commands always fail this check.
 */
export function isFocusedCheckCommand(command: string | readonly string[] | undefined): boolean {
  if (command === undefined) return false;
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv') return false;
  const words = [canonical.executable ?? '', ...(canonical.args ?? [])]
    .map((part) => String(part))
    .filter(Boolean);
  if (words.length < 2) return false;
  const program = words[0]!.split(/[\\/]/).at(-1)!.toLowerCase();
  const rest = words.slice(1);
  const lowerRest = rest.map((word) => word.toLowerCase());
  const joined = lowerRest.join(' ');

  if (joined.includes('--coverage') || joined.includes('./...')) return false;

  // Skip the first non-flag token when it is a known test verb (e.g. `bun test`, `cargo test`).
  const VERBS = new Set(['test', 'check', 'run']);
  const pathCandidates = rest.filter((word, index) => {
    if (word.startsWith('-')) return false;
    // First positional after program is often the verb, not a path.
    if (index === 0 && VERBS.has(word.toLowerCase())) return false;
    return true;
  });

  const hasPathLike = pathCandidates.some((word) => (
    word.includes('/')
    || word.includes('\\')
    || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|test|spec)$/i.test(word)
    || /^(tests?|src|pkg|app|lib)\b/i.test(word)
  ));
  const hasNameFilter = lowerRest.some((word) =>
    word === '-t'
    || word === '--test-name-pattern'
    || word.startsWith('--test-name-pattern=')
    || word === '-k'
    || word.startsWith('-k=')
    || word === '--filter'
    || word.startsWith('--filter=')
    || word === '-p'
    || word.startsWith('-p=')
    || word === '--package'
    || word.startsWith('--package='));

  if (program === 'bun' && lowerRest[0] === 'test') {
    // Require an explicit file/filter beyond bare `bun test`.
    return pathCandidates.length >= 1 && (hasPathLike || hasNameFilter);
  }
  if (program === 'node' && lowerRest.some((w) => w === '--test' || w.startsWith('--test='))) {
    return hasPathLike || hasNameFilter;
  }
  if (program === 'pytest' || program === 'py.test') {
    return pathCandidates.length >= 1 && (hasPathLike || hasNameFilter);
  }
  if (program === 'go' && lowerRest[0] === 'test') {
    return hasPathLike || hasNameFilter;
  }
  if (program === 'cargo' && (lowerRest[0] === 'test' || lowerRest[0] === 'check')) {
    // Bare `cargo test` runs the full suite — require package/filter/target.
    return hasPathLike || hasNameFilter || lowerRest.includes('--lib') || lowerRest.includes('--bin')
      || lowerRest.some((w) => w.startsWith('--bin=') || w.startsWith('--package') || w.startsWith('--test'));
  }
  // npm/pnpm/yarn test are never focused — arbitrary package scripts.
  if (['npm', 'pnpm', 'yarn'].includes(program) && lowerRest[0] === 'test') {
    return false;
  }
  return false;
}

function commandLooksDestructive(command: string | readonly string[] | undefined): boolean {
  if (command === undefined) return false;
  const text = Array.isArray(command)
    ? command.join(' ')
    : typeof command === 'string'
      ? command
      : String((command as { shellCommand?: string }).shellCommand ?? '');
  const lower = text.toLowerCase();
  return DESTRUCTIVE_HINTS.some((hint) => lower.includes(hint));
}

export function pathsOutOfScope(paths: string[] | undefined, allowedPaths: string[] | undefined): boolean {
  if (!paths?.length || !allowedPaths?.length) return false;
  return paths.some((path) => !pathAllowed(path, allowedPaths));
}

export function pathAllowed(path: string, allowedPaths: string[]): boolean {
  const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/');
  if (normalized.includes('..')) return false;
  return allowedPaths.some((allowed) => {
    const pattern = allowed.replace(/^\.\//, '').replace(/\\/g, '/');
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      return normalized.startsWith(`${prefix}/`) && !normalized.slice(prefix.length + 1).includes('/');
    }
    return normalized === pattern || normalized.startsWith(`${pattern}/`);
  });
}

export function extractPatchPaths(operations: unknown): string[] {
  if (!Array.isArray(operations)) return [];
  return [...new Set(
    operations
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => String(entry.path ?? '').trim().replace(/\\/g, '/'))
      .filter(Boolean),
  )];
}

/**
 * Small, explicit execution router. Returns fast | durable | reject only.
 * Never silently upgrades mid-execution — callers must re-issue durable requests.
 */
export function routeExecution(input: RouteExecutionInput): ExecutionDecision {
  const reasons: string[] = [];
  const operation = String(input.operation || 'unknown');
  const requested = input.mode ?? 'auto';
  const scopedPaths = [
    ...(input.paths ?? []),
    ...(input.patchPaths ?? []),
  ];

  if (requested === 'durable') {
    return {
      mode: 'durable',
      reasons: ['caller_requested_durable'],
      risk: 'unknown',
      estimatedClass: 'long',
      requiresIsolation: input.requiresIsolation === true,
      requiresRecovery: input.requiresRecovery === true,
      suggestedOperation: durableSuggestion(operation),
    };
  }

  if (commandLooksDestructive(input.command) || operation.includes('destructive')) {
    return {
      mode: 'reject',
      reasons: ['destructive_operation_requires_strong_confirmation'],
      risk: 'destructive',
      estimatedClass: 'unknown',
      requiresIsolation: true,
      requiresRecovery: false,
      rejectCode: 'DESTRUCTIVE_REJECTED',
      suggestedOperation: 'repository_command_preview + explicit strong confirmation via Durable Work',
    };
  }

  if (pathsOutOfScope(scopedPaths, input.allowedPaths)) {
    return {
      mode: 'reject',
      reasons: ['paths_outside_declared_scope'],
      risk: 'workspace_write',
      estimatedClass: 'short',
      requiresIsolation: false,
      requiresRecovery: false,
      rejectCode: 'PATH_SCOPE_REJECTED',
    };
  }

  if (input.background === true) reasons.push('background_execution_requested');
  if (input.requiresRecovery === true) reasons.push('cross_session_recovery_required');
  if (input.requiresIsolation === true || input.requiresWorktree === true) reasons.push('isolation_or_worktree_required');
  if (input.requiresRetry === true) reasons.push('durable_retry_required');
  if (input.agentRun === true) reasons.push('agent_run');
  if (input.interactionSession === true) reasons.push('long_interaction_session');
  if (input.humanHandoff === true) reasons.push('human_handoff_required');
  if (input.remoteWrite === true) reasons.push('remote_write');
  if (input.concurrentWriteLanes === true) reasons.push('concurrent_write_lanes');
  if (typeof input.timeoutMs === 'number' && input.timeoutMs > FAST_PATH_MAX_TIMEOUT_MS) {
    reasons.push(`timeout_exceeds_fast_cap_${FAST_PATH_MAX_TIMEOUT_MS}`);
  }
  if (DURABLE_OPERATIONS.has(operation)) reasons.push(`operation_${operation}_is_durable_by_policy`);

  if (operation === 'repository_command_execute' || operation === 'run_short_command' || operation === 'run_focused_check') {
    if (input.command !== undefined) {
      const classification = classifyRepositoryCommand(input.command, input.defaultBranch);
      const canonical = normalizeRepositoryCommand(input.command);
      if (canonical.kind !== 'argv' && (operation === 'run_focused_check' || operation === 'run_short_command')) {
        reasons.push('shell_command_not_allowed_on_fast_path');
      }
      if (classification.risk === 'remote_write') reasons.push('command_classified_remote_write');
      if (classification.risk === 'destructive') {
        return {
          mode: 'reject',
          reasons: ['command_classified_destructive', ...classification.reasons],
          risk: 'destructive',
          estimatedClass: 'unknown',
          requiresIsolation: true,
          requiresRecovery: false,
          rejectCode: 'DESTRUCTIVE_COMMAND',
          suggestedOperation: 'repository_command_preview',
        };
      }
      const focused = isFocusedCheckCommand(input.command);
      if (operation === 'run_focused_check' && !focused) {
        reasons.push('not_a_strict_focused_check');
      }
      if (classification.risk === 'workspace_write' && !focused) {
        if (operation === 'repository_command_execute' || operation === 'run_short_command' || operation === 'run_focused_check') {
          reasons.push('mutating_or_unfocused_command');
        }
      }
      if (classification.risk !== 'readonly' && !focused && !FAST_OPERATIONS.has(operation)) {
        reasons.push('untrusted_or_unclassified_command');
      }
    } else if (operation === 'repository_command_execute' || operation === 'run_focused_check') {
      reasons.push('missing_command');
    }
  }

  if (operation === 'batch' && input.steps) {
    if (input.steps.length === 0) {
      return {
        mode: 'reject',
        reasons: ['batch_requires_at_least_one_step'],
        risk: 'unknown',
        estimatedClass: 'short',
        requiresIsolation: false,
        requiresRecovery: false,
        rejectCode: 'EMPTY_BATCH',
      };
    }
    if (input.steps.length > FAST_BATCH_MAX_STEPS) {
      reasons.push(`batch_exceeds_max_steps_${FAST_BATCH_MAX_STEPS}`);
    }
    for (const step of input.steps) {
      const stepDecision = routeExecution({
        operation: step.kind,
        mode: 'auto',
        command: step.input.command as string | string[] | undefined,
        paths: Array.isArray(step.input.paths) ? step.input.paths.map(String) : undefined,
        patchPaths: extractPatchPaths(step.input.operations),
        allowedPaths: input.allowedPaths,
        timeoutMs: typeof step.input.timeout_ms === 'number' ? step.input.timeout_ms : input.timeoutMs,
        patchOperationCount: Array.isArray(step.input.operations) ? step.input.operations.length : undefined,
        defaultBranch: input.defaultBranch,
      });
      if (stepDecision.mode === 'reject') {
        return {
          ...stepDecision,
          reasons: [`batch_step_${step.kind}_rejected`, ...stepDecision.reasons],
        };
      }
      if (stepDecision.mode === 'durable') {
        return {
          mode: 'durable',
          reasons: [`batch_step_${step.kind}_requires_durable`, ...stepDecision.reasons],
          risk: stepDecision.risk,
          estimatedClass: 'long',
          requiresIsolation: stepDecision.requiresIsolation,
          requiresRecovery: stepDecision.requiresRecovery,
          suggestedOperation: stepDecision.suggestedOperation ?? 'create durable work / run_check',
        };
      }
    }
  }

  if (reasons.length > 0) {
    if (requested === 'fast') {
      return {
        mode: 'durable',
        reasons: ['fast_requested_but_policy_requires_durable', ...reasons],
        risk: 'unknown',
        estimatedClass: 'long',
        requiresIsolation: input.requiresIsolation === true,
        requiresRecovery: input.requiresRecovery === true,
        suggestedOperation: durableSuggestion(operation),
      };
    }
    return {
      mode: 'durable',
      reasons,
      risk: input.remoteWrite ? 'remote_write' : 'unknown',
      estimatedClass: 'long',
      requiresIsolation: input.requiresIsolation === true || input.requiresWorktree === true,
      requiresRecovery: input.requiresRecovery === true,
      suggestedOperation: durableSuggestion(operation),
    };
  }

  if (!FAST_OPERATIONS.has(operation) && operation !== 'repository_command_execute') {
    return {
      mode: 'durable',
      reasons: ['operation_not_in_fast_allowlist'],
      risk: 'unknown',
      estimatedClass: 'unknown',
      requiresIsolation: false,
      requiresRecovery: false,
      suggestedOperation: durableSuggestion(operation),
    };
  }

  if (operation === 'repository_command_execute' || operation === 'run_short_command' || operation === 'run_focused_check') {
    if (input.command === undefined) {
      return {
        mode: 'durable',
        reasons: ['repository_command_requires_classification'],
        risk: 'unknown',
        estimatedClass: 'unknown',
        requiresIsolation: false,
        requiresRecovery: false,
        suggestedOperation: 'repository_command_execute via Durable Work',
      };
    }
    const classification = classifyRepositoryCommand(input.command, input.defaultBranch);
    const focused = isFocusedCheckCommand(input.command);
    const canonical = normalizeRepositoryCommand(input.command);
    if (canonical.kind !== 'argv') {
      return {
        mode: 'durable',
        reasons: ['shell_command_requires_durable'],
        risk: riskFromClassification(classification.risk),
        estimatedClass: 'long',
        requiresIsolation: false,
        requiresRecovery: false,
        suggestedOperation: 'repository_command_execute via Durable Work / Local Job',
      };
    }
    if (classification.risk === 'readonly' || focused) {
      return {
        mode: 'fast',
        reasons: focused ? ['strict_focused_check_command'] : ['readonly_allowlisted_command'],
        risk: riskFromClassification(classification.risk),
        estimatedClass: 'short',
        requiresIsolation: false,
        requiresRecovery: false,
      };
    }
    return {
      mode: 'durable',
      reasons: ['command_not_eligible_for_fast', ...classification.reasons],
      risk: riskFromClassification(classification.risk),
      estimatedClass: 'long',
      requiresIsolation: false,
      requiresRecovery: false,
      suggestedOperation: 'repository_command_execute via Durable Work / Local Job',
    };
  }

  let risk: ExecutionRisk = 'readonly';
  if (['apply_patch', 'stage_paths', 'commit_paths', 'repository_safe_patch_apply', 'git_stage_paths', 'git_commit_paths', 'apply_edit_operations'].includes(operation)) {
    risk = 'workspace_write';
  }
  if (typeof input.patchOperationCount === 'number' && input.patchOperationCount > 100) {
    return {
      mode: 'durable',
      reasons: ['patch_too_large_for_fast_path'],
      risk: 'workspace_write',
      estimatedClass: 'long',
      requiresIsolation: false,
      requiresRecovery: false,
      suggestedOperation: 'repository_safe_patch_apply with apply_mode=async',
    };
  }

  return {
    mode: 'fast',
    reasons: requested === 'fast' ? ['caller_requested_fast', 'policy_allows_fast'] : ['auto_selected_fast'],
    risk,
    estimatedClass: 'short',
    requiresIsolation: false,
    requiresRecovery: false,
  };
}

function durableSuggestion(operation: string): string {
  if (operation === 'run_check' || operation === 'run_focused_check') return 'run_check through Durable Work';
  if (operation.includes('patch')) return 'repository_safe_patch_apply with apply_mode=async or Durable Work';
  if (operation.includes('command')) return 'repository_command_execute through Durable Work / Local Job';
  if (operation.includes('agent') || operation === 'quick_agent_session') return 'quick_agent_session / dispatch_task';
  if (operation.includes('campaign')) return 'Campaign (opt-in long orchestration only)';
  return 'Durable Work (ExecutionJob path)';
}

export function isFastEligibleTool(name: string, args: Record<string, unknown> = {}): boolean {
  const decision = routeExecution({
    operation: name,
    mode: args.mode === 'durable' || args.apply_mode === 'async' || args.async === true ? 'durable' : args.mode === 'fast' ? 'fast' : 'auto',
    background: args.background === true || args.apply_mode === 'async' || args.async === true,
    requiresRecovery: args.requires_recovery === true,
    requiresIsolation: args.isolation === 'new_worktree' || args.requires_isolation === true,
    requiresWorktree: args.isolation === 'new_worktree',
    agentRun: name === 'quick_agent_session' || name === 'dispatch_task',
    remoteWrite: name.includes('push') || name === 'publish_issue_to_github',
    timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    command: args.command as string | string[] | undefined,
    paths: Array.isArray(args.paths) ? args.paths.map(String) : undefined,
    allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
    patchOperationCount: Array.isArray(args.operations) ? args.operations.length : undefined,
    patchPaths: extractPatchPaths(args.operations),
  });
  return decision.mode === 'fast';
}
