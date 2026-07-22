import { normalizeRepositoryCommand, type CanonicalRepositoryCommand } from './command-normalization';

export type RepositoryCommandRisk = 'readonly' | 'workspace_write' | 'remote_write' | 'destructive';
export type RepositoryCommandAuthorization = 'explicit_user_request' | 'confirmed_plan' | 'policy' | 'full_access' | 'goal_delegation' | 'gpt_risk_delegate' | 'user_confirmation';
export type RepositoryCommandConfirmation = 'none' | 'authorization' | 'strong_confirmation';

export interface RepositoryCommandClassification {
  risk: RepositoryCommandRisk;
  confirmation: RepositoryCommandConfirmation;
  reasons: string[];
}

export type RepositoryCommandReplayPolicy = 'none' | 'safe_retry' | 'idempotent_request';

export interface RepositoryCommandReplayClassification {
  replayable: boolean;
  idempotent: boolean;
  retryPolicy: RepositoryCommandReplayPolicy;
  reasons: string[];
}

const READ_ONLY_PROGRAMS = new Set([
  'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'which', 'whereis', 'basename',
  'dirname', 'printf', 'echo', 'true', 'false', 'ps', 'pgrep', 'date', 'uname',
  'id', 'whoami', 'du', 'df', 'realpath', 'readlink', 'jq', 'shasum', 'sha256sum',
  // Pure delay/wait utilities do not mutate the repository; used by Fast Path concurrency tests.
  'sleep',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'grep', 'merge-base', 'rev-list',
  'rev-parse', 'for-each-ref', 'show-ref', 'ls-files', 'ls-tree', 'cat-file',
  'name-rev', 'describe', 'shortlog', 'reflog', 'fsck', 'ls-remote',
  'count-objects', 'verify-pack',
]);

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ';' || character === '|' || character === '&') {
      flush();
      if (command[index + 1] === character) index += 1;
      continue;
    }
    current += character;
  }
  flush();
  return segments;
}

function isSedInPlaceSegment(segment: string): boolean {
  const words = firstWords(segment);
  if (words[0]?.toLowerCase() !== 'sed') return false;
  return words.slice(1).some((word) => word === '--in-place'
    || word.startsWith('--in-place=')
    || /^-[^-]*i/.test(word));
}

function hasRepositoryOutputRedirection(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== '>' || command[index - 1] === '=') continue;

    let targetIndex = index + 1;
    if (command[targetIndex] === '>') targetIndex += 1;
    while (/\s/.test(command[targetIndex] ?? '')) targetIndex += 1;
    if (command[targetIndex] === '&' && /\d/.test(command[targetIndex + 1] ?? '')) continue;
    if (command.slice(targetIndex).startsWith('/dev/null')) continue;
    return true;
  }
  return false;
}

function firstWords(segment: string): string[] {
  return segment
    .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, '')
    .split(/\s+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ''));
}

function hasGitFlag(words: string[], ...flags: string[]): boolean {
  return words.some((word) => flags.includes(word));
}

/**
 * Shared Git readonly subcommand gate for shell segments and typed argv.
 * Mutating branch/tag/remote/config/worktree flags stay non-readonly.
 */
function isReadOnlyGitCommand(words: string[]): boolean {
  const subcommand = words[1]?.toLowerCase();
  if (!subcommand) return false;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === 'branch') {
    if (hasGitFlag(words, '-d', '-D', '-m', '-M', '--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream')
      || words.some((word) => word.startsWith('--set-upstream-to='))) {
      return false;
    }
    return words.length === 2
      || hasGitFlag(
        words,
        '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv',
        '--merged', '--no-merged', '--contains', '--no-contains', '--points-at', '--show-current',
      )
      || words.some((word) => word.startsWith('--contains=') || word.startsWith('--points-at='));
  }
  if (subcommand === 'tag') {
    return words.length === 2
      || hasGitFlag(words, '-l', '--list', '--points-at', '--contains', '--no-contains')
      || words.some((word) => word.startsWith('--contains=') || word.startsWith('--points-at='));
  }
  if (subcommand === 'remote') {
    return words.length === 2
      || hasGitFlag(words, '-v', '--verbose')
      || words[2]?.toLowerCase() === 'show'
      || words[2]?.toLowerCase() === 'get-url';
  }
  if (subcommand === 'config') {
    return hasGitFlag(words, '--get', '--get-all', '--get-regexp', '--list', '-l');
  }
  if (subcommand === 'worktree') {
    return words[2]?.toLowerCase() === 'list';
  }
  return false;
}

function readOnlyGitSegment(words: string[], _segment: string): boolean {
  return isReadOnlyGitCommand(words);
}

function isReadOnlySegment(segment: string): boolean {
  const words = firstWords(segment);
  const program = words[0]?.toLowerCase();
  if (!program) return false;
  if (program === 'git') return readOnlyGitSegment(words, segment);
  if (program === 'find') return !/(?:-delete|-exec|-execdir|-ok|-okdir)\b/.test(segment);
  if (program === 'sed') return !isSedInPlaceSegment(segment);
  if (program === 'gh') {
    return /\bgh\s+(?:repo\s+view|pr\s+(?:list|view|status|checks|diff)|issue\s+(?:list|view)|run\s+(?:list|view|watch)|release\s+(?:list|view|download))(?:\s|$)/.test(segment);
  }
  return READ_ONLY_PROGRAMS.has(program);
}

/** Package scripts that are local validation (not install/publish/mutate deps). */
const SAFE_PACKAGE_SCRIPT = /^(?:test|check|lint|typecheck|format:check|tsc)(?::|$)/i;

function isSafePackageRunner(program: string, words: string[]): boolean {
  if (!['bun', 'npm', 'pnpm', 'yarn', 'node'].includes(program)) return false;
  // bun test <path>, npm test, etc.
  if (words[1]?.toLowerCase() === 'test') return true;
  // bun run check:type / npm run lint / pnpm run typecheck
  if (words[1]?.toLowerCase() === 'run' && words[2] && SAFE_PACKAGE_SCRIPT.test(words[2])) return true;
  // bunx tsc --noEmit / npx eslint
  if ((program === 'bun' && words[1]?.toLowerCase() === 'x') || program === 'node') {
    const tool = words[program === 'node' ? 1 : 2]?.toLowerCase();
    if (tool === 'tsc' || tool === 'eslint' || tool === 'biome') return true;
  }
  return false;
}

function isReplaySafeValidationWords(words: string[]): boolean {
  const program = words[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  const subcommand = words[1]?.toLowerCase();
  if (!program) return false;
  if (isSafePackageRunner(program, words)) return true;
  if (program === 'bun') return subcommand === 'test';
  if (program === 'node') return words.slice(1).some((word) => word === '--test' || word.startsWith('--test='));
  if (program === 'go') return subcommand === 'test';
  if (program === 'cargo') return subcommand === 'test' || subcommand === 'check';
  if (program === 'swift') return subcommand === 'test';
  if (program === 'tsc') return true;
  if (program === 'eslint' || program === 'biome') return true;
  if (program === 'pytest' || program === 'py.test') return true;
  if ((program === 'python' || program === 'python3') && subcommand === '-m') return words[2]?.toLowerCase() === 'pytest';
  if (program === 'mvn' || program === 'mvnw') return words.slice(1).some((word) => word === 'test' || word === 'verify');
  if (program === 'gradle' || program === 'gradlew') return words.slice(1).some((word) => word === 'test' || word === 'check');
  if (program === 'xcodebuild') {
    return words.slice(1).some((word) => ['build', 'test', 'build-for-testing', 'test-without-building'].includes(word.toLowerCase()));
  }
  return false;
}

function isReplaySafeValidationSegment(segment: string): boolean {
  return isReplaySafeValidationWords(firstWords(segment));
}

/**
 * Dangerous shell constructs that must never ride the Process Runtime / Fast Path
 * even when individual segments look like tests or readonly tools.
 */
export function shellCommandHasUnsafeConstructs(command: string): { unsafe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const normalized = command.trim();
  // Background jobs
  if (/(?:^|[^&])&(?:[^&]|$)/.test(normalized.replace(/&&/g, ' '))) {
    reasons.push('background execution (&) is not allowed on the direct process path');
  }
  // Dynamic substitution / eval
  if (/(?:^|[\s;|&])eval(?:\s|$)/i.test(normalized)) reasons.push('eval is not allowed');
  if (/\$\([^)]*\)/.test(normalized) || /`[^`]+`/.test(normalized)) {
    reasons.push('command substitution is not allowed');
  }
  if (/\$\{[^}]+\}/.test(normalized) && !/\$\{\w+\}/.test(normalized.replace(/\$\{\w+\}/g, ''))) {
    // keep simple ${VAR} allowed later; complex nested expansions flagged below
  }
  // Download-and-execute
  if (/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|fish)\b/i.test(normalized)) {
    reasons.push('download-and-execute pipelines are not allowed');
  }
  if (/\b(?:curl|wget)\b[\s\S]*\b(?:-o|--output)\b[\s\S]*&&\s*(?:sh|bash|\.\/)/i.test(normalized)) {
    reasons.push('download then execute is not allowed');
  }
  // Path escape hints
  if (/(?:^|[\s"'])\.\.\/(?:\.\.\/)*/.test(normalized)) {
    reasons.push('parent-directory path traversal requires durable review');
  }
  return { unsafe: reasons.length > 0, reasons };
}

/**
 * Safe fixed shell combinations: every segment is readonly or a known local
 * validation command, joined only by && or ; (not pipes that mix side effects).
 * Example: `bun test tests/a.test.ts && bun run check:type`
 */
export function isSafeFixedShellCombination(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  if (shellCommandHasUnsafeConstructs(normalized).unsafe) return false;
  if (hasRepositoryOutputRedirection(normalized)) return false;
  // Reject bare pipes that feed dynamic interpreters
  if (/\|\s*(?:sh|bash|zsh|python|node|perl|ruby)\b/i.test(normalized)) return false;
  const segments = shellSegments(normalized);
  if (segments.length === 0) return false;
  return segments.every((segment) => isReadOnlySegment(segment) || isReplaySafeValidationSegment(segment));
}

/**
 * When a shell string is a safe fixed combination, classify at the highest risk
 * among segments (readonly if all readonly, else workspace_write for validation).
 */
export function classifySafeShellCombination(command: string): RepositoryCommandClassification | undefined {
  if (!isSafeFixedShellCombination(command)) return undefined;
  const segments = shellSegments(command);
  const allReadonly = segments.every(isReadOnlySegment);
  if (allReadonly) {
    return {
      risk: 'readonly',
      confirmation: 'none',
      reasons: ['safe fixed shell combination of repository-local read operations'],
    };
  }
  return {
    risk: 'workspace_write',
    confirmation: 'none',
    reasons: ['safe fixed shell combination of local validation commands'],
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifyRepositoryCommand(
  input: string | readonly string[] | CanonicalRepositoryCommand,
  defaultBranch?: string,
): RepositoryCommandClassification {
  const canonical = 'kind' in Object(input) && (input as CanonicalRepositoryCommand).kind
    ? input as CanonicalRepositoryCommand
    : normalizeRepositoryCommand(input);
  if (canonical.kind === 'argv') return classifyArgvCommand(canonical, defaultBranch);
  return classifyShellCommand(canonical.shellCommand!, defaultBranch);
}

export function classifyRepositoryCommandReplay(
  input: string | readonly string[] | CanonicalRepositoryCommand,
  defaultBranch?: string,
): RepositoryCommandReplayClassification {
  const canonical = 'kind' in Object(input) && (input as CanonicalRepositoryCommand).kind
    ? input as CanonicalRepositoryCommand
    : normalizeRepositoryCommand(input);
  const classification = classifyRepositoryCommand(canonical, defaultBranch);
  if (classification.risk === 'readonly') {
    return {
      replayable: true,
      idempotent: true,
      retryPolicy: 'safe_retry',
      reasons: ['recognized read-only repository command'],
    };
  }
  if (classification.risk === 'remote_write' || classification.risk === 'destructive') {
    return {
      replayable: false,
      idempotent: false,
      retryPolicy: 'none',
      reasons: ['remote or destructive commands require outcome review after execution starts'],
    };
  }
  const shellParts = canonical.kind === 'shell' ? shellSegments(canonical.shellCommand!) : [];
  const validationOnly = canonical.kind === 'argv'
    ? isReplaySafeValidationWords([canonical.executable!, ...(canonical.args ?? [])])
    : !hasRepositoryOutputRedirection(canonical.shellCommand!)
      && !shellParts.some(isSedInPlaceSegment)
      && shellParts.length > 0
      && shellParts.every((segment) => isReadOnlySegment(segment) || isReplaySafeValidationSegment(segment));
  if (validationOnly) {
    return {
      replayable: true,
      idempotent: true,
      retryPolicy: 'idempotent_request',
      reasons: ['recognized local validation command with repeatable repository effects'],
    };
  }
  return {
    replayable: false,
    idempotent: false,
    retryPolicy: 'none',
    reasons: ['command outcome must be reviewed before replay'],
  };
}

function classifyArgvCommand(
  command: CanonicalRepositoryCommand,
  defaultBranch?: string,
): RepositoryCommandClassification {
  const argv = [command.executable!, ...(command.args ?? [])];
  const program = argv[0]!.split(/[\\/]/).at(-1)!.toLowerCase();
  const subcommand = argv[1]?.toLowerCase();
  const reasons: string[] = [];
  const has = (value: string) => argv.includes(value);
  const forcePush = program === 'git' && subcommand === 'push' && (has('--force') || has('--force-with-lease') || has('-f') || argv.some((arg) => arg.startsWith('+')));
  const hardReset = program === 'git' && subcommand === 'reset' && has('--hard');
  const cleanAll = program === 'git' && subcommand === 'clean' && (has('-fdx') || argv.some((arg) => arg.startsWith('-') && arg.includes('x') && arg.includes('f')));
  const deleteRemote = program === 'git' && subcommand === 'push' && (has('--delete') || argv.some((arg) => arg.startsWith(':')));
  const deletesDefault = Boolean(defaultBranch && deleteRemote && argv.includes(defaultBranch));
  if (forcePush) reasons.push('force push rewrites shared remote history');
  if (hardReset) reasons.push('hard reset can discard local changes and commits');
  if (cleanAll) reasons.push('git clean can permanently remove untracked or ignored files');
  if (deletesDefault) reasons.push(`remote deletion targets the default branch ${defaultBranch}`);
  if (reasons.length > 0) return { risk: 'destructive', confirmation: 'strong_confirmation', reasons };
  if (program === 'git' && ((subcommand === 'push' && deleteRemote) || (['branch', 'tag'].includes(subcommand ?? '') && (has('--delete') || has('-d') || has('-D'))))) {
    return { risk: 'destructive', confirmation: 'authorization', reasons: ['deletes a remote branch or tag'] };
  }
  if (program === 'rm' || program === 'rmdir' || program === 'unlink' || (program === 'find' && has('-delete'))) {
    return { risk: 'destructive', confirmation: 'authorization', reasons: ['deletes repository files'] };
  }
  if (program === 'git' && subcommand === 'push') return { risk: 'remote_write', confirmation: 'authorization', reasons: ['writes Git refs to a remote'] };
  if (program === 'git' && isReadOnlyGitCommand(argv)) {
    return { risk: 'readonly', confirmation: 'none', reasons: ['the argv command is a recognized repository-local read operation'] };
  }
  // Explicit readonly GitHub CLI observations (must not be treated as workspace write).
  if (program === 'gh') {
    const group = subcommand ?? '';
    const action = (argv[2] ?? '').toLowerCase();
    const readonlyGh =
      (group === 'repo' && action === 'view')
      || (group === 'pr' && ['list', 'view', 'status', 'checks', 'diff'].includes(action))
      || (group === 'issue' && ['list', 'view'].includes(action))
      || (group === 'run' && ['list', 'view', 'watch'].includes(action))
      || (group === 'release' && ['list', 'view', 'download'].includes(action));
    if (readonlyGh) {
      return { risk: 'readonly', confirmation: 'none', reasons: ['the argv command is a recognized GitHub read operation'] };
    }
  }
  if (program === 'git' && ['add', 'commit', 'pull', 'fetch', 'merge', 'rebase', 'checkout', 'switch', 'cherry-pick', 'revert', 'stash', 'mv', 'restore', 'apply', 'am', 'bisect'].includes(subcommand ?? '')) {
    return { risk: 'workspace_write', confirmation: 'authorization', reasons: ['changes the checkout, local refs, index, or working tree'] };
  }
  if (['touch', 'mkdir', 'cp', 'mv', 'install', 'tee', 'truncate', 'patch'].includes(program)
    || (['npm', 'bun', 'pnpm', 'yarn'].includes(program) && ['install', 'add', 'remove', 'update', 'run'].includes(subcommand ?? ''))) {
    return { risk: 'workspace_write', confirmation: 'authorization', reasons: ['writes repository files'] };
  }
  // Lightweight project script info queries stay readonly when they only request help/version.
  if (['bun', 'node', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'cargo', 'go', 'swift'].includes(program)
    && argv.slice(1).some((word) => word === '--help' || word === '-h' || word === '--version' || word === '-V' || word === 'version' || word === 'help')) {
    const mutating = argv.slice(1).some((word) => ['install', 'add', 'remove', 'update', 'publish', 'run', 'test', 'build'].includes(word.toLowerCase()));
    if (!mutating) {
      return { risk: 'readonly', confirmation: 'none', reasons: ['the argv command only requests help or version information'] };
    }
  }
  if (program === 'git' && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand ?? '')) {
    return { risk: 'readonly', confirmation: 'none', reasons: ['the argv command is a recognized repository-local read operation'] };
  }
  if (READ_ONLY_PROGRAMS.has(program)) return { risk: 'readonly', confirmation: 'none', reasons: ['the argv command is a recognized repository-local read operation'] };
  return { risk: 'workspace_write', confirmation: 'authorization', reasons: ['unrecognized argv behavior is conservatively treated as a workspace write'] };
}

function classifyShellCommand(
  command: string,
  defaultBranch?: string,
): RepositoryCommandClassification {
  const normalized = command.trim();
  const reasons: string[] = [];

  // Reject unsafe constructs early (background, eval, download|sh, substitution).
  const unsafe = shellCommandHasUnsafeConstructs(normalized);
  if (unsafe.unsafe) {
    return {
      risk: 'destructive',
      confirmation: 'strong_confirmation',
      reasons: unsafe.reasons,
    };
  }

  // Allow safe fixed combinations (e.g. bun test path && bun run check:type)
  // without forcing Durable merely because the command is a shell string with &&.
  const safeCombo = classifySafeShellCombination(normalized);
  if (safeCombo) return safeCombo;

  const forcePush = /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|-f(?:\s|$)|\+[^\s:]+:[^\s]+)/i.test(normalized);
  const hardReset = /\bgit\s+reset\b[^\n]*--hard\b/i.test(normalized);
  const cleanAll = /\bgit\s+clean\b[^\n]*(?:-[a-z]*x|--force)/i.test(normalized);
  const deleteRemote = /\bgit\s+push\b[^\n]*(?:--delete\b|\s:[^\s]+)/i.test(normalized);
  const deletesDefault = Boolean(defaultBranch && deleteRemote
    && new RegExp(`(?:^|[\\s/:])${escapeRegex(defaultBranch)}(?:\\s|$)`, 'i').test(normalized));
  const broadDelete = /(?:^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\.|\*|[^\s]*\/\*)(?:\s|$)/i.test(normalized);

  if (forcePush) reasons.push('force push rewrites shared remote history');
  if (hardReset) reasons.push('hard reset can discard local changes and commits');
  if (cleanAll) reasons.push('git clean can permanently remove untracked or ignored files');
  if (deletesDefault) reasons.push(`remote deletion targets the default branch ${defaultBranch}`);
  if (broadDelete) reasons.push('broad recursive file deletion was requested');
  if (reasons.length > 0) return { risk: 'destructive', confirmation: 'strong_confirmation', reasons };

  const destructivePatterns: Array<[RegExp, string]> = [
    [/\bgit\s+push\b[^\n]*(?:--delete\b|\s:[^\s]+)/i, 'deletes a remote branch or tag'],
    [/\bgit\s+(?:branch|tag)\b[^\n]*(?:\s-[dD]\b|\s--delete\b)/i, 'deletes a local branch or tag'],
    [/\bgit\s+(?:checkout|restore)\b[^\n]*(?:--force\b|-f\b|--worktree\b|--source\b)/i, 'may overwrite working-tree content'],
    [/(?:^|[;&|]\s*)(?:rm|rmdir|unlink)(?:\s|$)/i, 'deletes repository files'],
    [/\bfind\b[^\n]*-delete\b/i, 'deletes repository files through find'],
  ];
  for (const [pattern, reason] of destructivePatterns) if (pattern.test(normalized)) reasons.push(reason);
  if (reasons.length > 0) return { risk: 'destructive', confirmation: 'authorization', reasons };

  const remoteWritePatterns: Array<[RegExp, string]> = [
    [/\bgit\s+push\b/i, 'writes Git refs to a remote'],
    [/\bgh\s+(?:pr\s+(?:create|edit|close|reopen|merge|comment|review)|issue\s+(?:create|edit|close|reopen|comment)|release\s+(?:create|edit|delete|upload)|repo\s+(?:create|edit|archive|delete))\b/i, 'writes GitHub remote state'],
    [/\b(?:npm|bun)\s+publish\b/i, 'publishes a package'],
  ];
  for (const [pattern, reason] of remoteWritePatterns) if (pattern.test(normalized)) reasons.push(reason);
  if (reasons.length > 0) return { risk: 'remote_write', confirmation: 'authorization', reasons };

  if (hasRepositoryOutputRedirection(normalized)) reasons.push('redirects output into a repository file');
  if (shellSegments(normalized).some(isSedInPlaceSegment)) reasons.push('edits repository files in place');
  if (reasons.length > 0) return { risk: 'workspace_write', confirmation: 'authorization', reasons };

  // Safe fixed validation combinations are already handled above. Remaining shell
  // package runners that are validation-only (test/check/lint/typecheck) are
  // workspace_write with no confirmation — they may write caches/snapshots but
  // do not require Durable solely because they use `bun run` / `npm run`.
  const segmentsRaw = shellSegments(normalized);
  if (segmentsRaw.length > 0 && segmentsRaw.every((segment) => isReadOnlySegment(segment) || isReplaySafeValidationSegment(segment))) {
    const allReadonly = segmentsRaw.every(isReadOnlySegment);
    return {
      risk: allReadonly ? 'readonly' : 'workspace_write',
      confirmation: allReadonly ? 'none' : 'none',
      reasons: allReadonly
        ? ['all command segments are recognized as repository-local read operations']
        : ['shell segments are recognized local validation commands'],
    };
  }

  const workspaceWritePatterns: Array<[RegExp, string]> = [
    [/\bgit\s+(?:add|commit|pull|fetch|merge|rebase|checkout|switch|cherry-pick|revert|stash|mv|rm|restore|apply|am|bisect)(?:\s|$)/i, 'changes the checkout, local refs, index, or working tree'],
    [/(?:^|[;&|]\s*)(?:touch|mkdir|cp|mv|install|tee|truncate|patch)(?:\s|$)/i, 'writes repository files'],
    // install/add/remove/update mutate deps; bare `run` of unknown scripts stays conservative below.
    [/(?:^|[;&|]\s*)(?:npm|bun|pnpm|yarn)\s+(?:install|add|remove|update)(?:\s|$)/i, 'may modify dependencies, generated files, or the working tree'],
    [/(?:^|[;&|]\s*)(?:npm|bun|pnpm|yarn)\s+run\s+(?!test|check|lint|typecheck|format:check|tsc)[a-z0-9:_-]+/i, 'may modify dependencies, generated files, or the working tree'],
  ];
  for (const [pattern, reason] of workspaceWritePatterns) if (pattern.test(normalized)) reasons.push(reason);
  if (reasons.length > 0) return { risk: 'workspace_write', confirmation: 'authorization', reasons };

  const segments = shellSegments(normalized.toLowerCase());
  if (segments.length > 0 && segments.every(isReadOnlySegment)) {
    return {
      risk: 'readonly',
      confirmation: 'none',
      reasons: ['all command segments are recognized as repository-local read operations'],
    };
  }
  return {
    risk: 'workspace_write',
    confirmation: 'authorization',
    reasons: ['unrecognized shell behavior is conservatively treated as a workspace write'],
  };
}
