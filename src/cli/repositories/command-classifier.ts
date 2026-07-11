export type RepositoryCommandRisk = 'readonly' | 'workspace_write' | 'remote_write' | 'destructive';
export type RepositoryCommandAuthorization = 'explicit_user_request' | 'confirmed_plan' | 'policy' | 'full_access' | 'goal_delegation' | 'gpt_risk_delegate' | 'user_confirmation';
export type RepositoryCommandConfirmation = 'none' | 'authorization' | 'strong_confirmation';

export interface RepositoryCommandClassification {
  risk: RepositoryCommandRisk;
  confirmation: RepositoryCommandConfirmation;
  reasons: string[];
}

const READ_ONLY_PROGRAMS = new Set([
  'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'which', 'whereis', 'basename',
  'dirname', 'printf', 'echo', 'true', 'false', 'ps', 'pgrep', 'date', 'uname',
  'id', 'whoami', 'du', 'df', 'realpath', 'readlink', 'jq', 'shasum', 'sha256sum',
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

function readOnlyGitSegment(words: string[], segment: string): boolean {
  const subcommand = words[1]?.toLowerCase();
  if (!subcommand) return false;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === 'branch') {
    if (/(?:^|\s)(?:-[dDmM]|--delete|--move|--copy|--set-upstream-to|--unset-upstream)(?:\s|$)/.test(segment)) return false;
    return words.length === 2
      || /(?:^|\s)(?:-a|--all|-r|--remotes|-l|--list|-v|-vv|--merged|--no-merged|--contains|--no-contains|--points-at|--show-current)(?:\s|$)/.test(segment);
  }
  if (subcommand === 'tag') {
    return words.length === 2
      || /(?:^|\s)(?:-l|--list|--points-at|--contains|--no-contains)(?:\s|$)/.test(segment);
  }
  if (subcommand === 'remote') {
    return words.length === 2 || /\bgit\s+remote\s+(?:-v|show|get-url)(?:\s|$)/.test(segment);
  }
  if (subcommand === 'config') {
    return /\bgit\s+config\s+(?:--get|--get-all|--get-regexp|--list|-l)(?:\s|$)/.test(segment);
  }
  if (subcommand === 'worktree') return /\bgit\s+worktree\s+list(?:\s|$)/.test(segment);
  return false;
}

function isReadOnlySegment(segment: string): boolean {
  const words = firstWords(segment);
  const program = words[0]?.toLowerCase();
  if (!program) return false;
  if (program === 'git') return readOnlyGitSegment(words, segment);
  if (program === 'find') return !/(?:-delete|-exec|-execdir|-ok|-okdir)\b/.test(segment);
  if (program === 'sed') return !isSedInPlaceSegment(segment);
  if (program === 'gh') {
    return /\bgh\s+(?:repo\s+view|pr\s+(?:list|view|status|checks|diff)|issue\s+(?:list|view)|run\s+(?:list|view|watch))(?:\s|$)/.test(segment);
  }
  return READ_ONLY_PROGRAMS.has(program);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifyRepositoryCommand(
  command: string,
  defaultBranch?: string,
): RepositoryCommandClassification {
  const normalized = command.trim();
  const reasons: string[] = [];
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

  const workspaceWritePatterns: Array<[RegExp, string]> = [
    [/\bgit\s+(?:add|commit|pull|fetch|merge|rebase|checkout|switch|cherry-pick|revert|stash|mv|rm|restore|apply|am|bisect)(?:\s|$)/i, 'changes the checkout, local refs, index, or working tree'],
    [/(?:^|[;&|]\s*)(?:touch|mkdir|cp|mv|install|tee|truncate|patch)(?:\s|$)/i, 'writes repository files'],
    [/(?:^|[;&|]\s*)(?:npm|bun|pnpm|yarn)\s+(?:install|add|remove|update|run)(?:\s|$)/i, 'may modify dependencies, generated files, or the working tree'],
  ];
  for (const [pattern, reason] of workspaceWritePatterns) if (pattern.test(normalized)) reasons.push(reason);
  if (hasRepositoryOutputRedirection(normalized)) reasons.push('redirects output into a repository file');
  if (shellSegments(normalized).some(isSedInPlaceSegment)) reasons.push('edits repository files in place');
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
