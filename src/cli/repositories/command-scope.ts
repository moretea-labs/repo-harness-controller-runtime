import { existsSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type { ExternalFilesystemGrant } from '../../runtime/safe-tooling/external-filesystem';
import { externalFilesystemGrantExpired } from '../../runtime/safe-tooling/external-filesystem';
import type { RepositoryRecord } from './types';

const MAX_COMMAND_LENGTH = 32 * 1024;

export type RepositoryCommandExternalPathOperation = 'external_read' | 'external_copy_into_workspace';

export interface RepositoryCommandExternalPathUsage {
  token: string;
  canonicalPath: string;
  operation: RepositoryCommandExternalPathOperation;
  grantKey: string;
  grantRoot: string;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  const parentPrefix = `..${process.platform === 'win32' ? '\\' : '/'}`;
  return rel === '' || (rel !== '..' && !rel.startsWith(parentPrefix) && !isAbsolute(rel));
}

function nearestExistingPath(candidate: string): string | undefined {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

export function resolveRepositoryCommandCwd(
  repository: RepositoryRecord,
  requestedCwd: string | undefined,
): { root: string; cwd: string; relativeCwd: string } {
  if (!repository.enabled) throw new Error(`REPOSITORY_DISABLED: ${repository.repoId}`);
  const root = realpathSync(repository.canonicalRoot);
  const raw = requestedCwd?.trim() || '.';
  if (raw.includes('\0')) throw new Error('COMMAND_SCOPE_DENIED: cwd contains a null byte');
  const candidate = resolve(root, raw);
  if (!existsSync(candidate)) throw new Error(`COMMAND_SCOPE_DENIED: cwd does not exist: ${raw}`);
  const cwd = realpathSync(candidate);
  if (!statSync(cwd).isDirectory()) throw new Error(`COMMAND_SCOPE_DENIED: cwd is not a directory: ${raw}`);
  const relativeCwd = relative(root, cwd) || '.';
  if (!pathInside(root, cwd)) throw new Error(`COMMAND_SCOPE_DENIED: cwd escapes repository root: ${raw}`);
  return { root, cwd, relativeCwd };
}

export function assertRepositoryCommandAllowed(command: string): string {
  const normalized = command.trim();
  if (!normalized) throw new Error('COMMAND_INVALID: command is required');
  if (normalized.length > MAX_COMMAND_LENGTH) {
    throw new Error(`COMMAND_INVALID: command exceeds ${MAX_COMMAND_LENGTH} characters`);
  }
  if (normalized.includes('\0')) throw new Error('COMMAND_INVALID: command contains a null byte');

  const denied: Array<[RegExp, string]> = [
    [/\$\(|`/, 'nested command substitution is not allowed'],
    [/(?:^|[;&|]\s*)(?:eval|source)\b|(?:^|[;&|]\s*)\.\s+[^/]/i, 'dynamic shell evaluation is not allowed'],
    [/\b(?:bash|sh|zsh|fish|dash|cmd|powershell|pwsh)\b\s+(?:-[^\s]*c\b|\/c\b)/i, 'nested shell execution is not allowed'],
    [/\b(?:python\d*|node|ruby|perl)\b\s+(?:-[ce]\b|--eval\b)/i, 'inline interpreter execution is not allowed'],
    [/(?:^|[\s'"=])(?:\.\.(?:\/|\\)|~(?:\/|\\)|[A-Za-z]:[\\/])/, 'ambiguous parent/home/drive paths are not allowed; use repo-relative paths or an authorized absolute external path'],
    [/(?:^|[;&|]\s*)cd(?:\s|$)/i, 'use the cwd argument instead of cd'],
    [/\b(?:env|printenv)\b|\bgh\s+auth\s+token\b|\bgit\s+credential\b|\bsecurity\s+find-(?:generic|internet)-password\b/i, 'credential or environment inspection is not allowed'],
    [/(?:^|[\s'"/])(?:\.ssh|\.aws|\.gnupg|Library\/Keychains|login\.keychain|\.config\/gh\/hosts\.yml)(?:[\s'"/]|$)/i, 'sensitive credential paths are not allowed'],
    [/(?:^|[;&|]\s*)(?:curl|wget|scp|sftp|ftp|nc|ncat|netcat|socat|ssh)(?:\s|$)/i, 'direct network or exfiltration utilities are not allowed'],
    [/\bgit\s+(?:--git-dir|--work-tree|-C)\b|\b(?:GIT_DIR|GIT_WORK_TREE)\s*=/i, 'Git repository scope overrides are not allowed'],
    [/\bgit\s+config\b[^\n]*(?:--global|--system)\b/i, 'global or system Git configuration changes are not allowed'],
  ];
  for (const [pattern, reason] of denied) {
    if (pattern.test(normalized)) throw new Error(`COMMAND_POLICY_DENIED: ${reason}`);
  }
  return normalized;
}

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
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { current += character; escaped = true; continue; }
    if (quote) { current += character; if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; current += character; continue; }
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

function shellWords(segment: string): string[] {
  return segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s<>]+/g)?.map((word) => word.replace(/^['"]|['"]$/g, '')) ?? [];
}

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[,*?]+$/g, '');
}

function sensitivePathDenied(canonicalPath: string): boolean {
  const lower = canonicalPath.toLowerCase();
  return [
    '/.ssh',
    '/.gnupg',
    '/library/keychains',
    '/library/application support/google/chrome/default/cookies',
    '/library/application support/google/chrome/default/network/cookies',
    '/library/application support/firefox/profiles',
    '/library/application support/1password',
    '/library/group containers/2bua8c4s2c.com.1password',
    '/.aws',
    '/.config/gcloud',
    '/.kube',
    '/id_rsa',
    '/id_dsa',
    '/id_ecdsa',
    '/id_ed25519',
  ].some((fragment) => lower.includes(fragment));
}

function readOnlyProgram(program: string | undefined): boolean {
  return Boolean(program && [
    'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'wc',
    'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'basename', 'dirname', 'printf',
    'echo', 'du', 'df', 'realpath', 'readlink', 'jq', 'shasum', 'sha256sum', 'find',
  ].includes(program.toLowerCase()));
}

function grantCoversPath(grant: ExternalFilesystemGrant, canonicalPath: string, operation: RepositoryCommandExternalPathOperation): boolean {
  if (externalFilesystemGrantExpired(grant)) return false;
  if (operation === 'external_read' && grant.mode !== 'read') return false;
  if (operation === 'external_copy_into_workspace' && grant.mode !== 'copy_into_repo') return false;
  const rel = relative(grant.canonicalRoot, canonicalPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

function operationForToken(words: string[], index: number, external: string, cwd: string, root: string): RepositoryCommandExternalPathOperation | 'external_write' | 'unsupported' {
  const program = words[0]?.toLowerCase();
  if (!program) return 'unsupported';
  if (program === 'cp' || program === 'install') {
    const operands = words.slice(1).filter((word) => word && !word.startsWith('-'));
    const operandIndex = operands.indexOf(external);
    const destination = operands.at(-1);
    if (operandIndex >= 0 && destination && external !== destination) {
      const destinationPath = resolve(cwd, stripTrailingPunctuation(destination));
      const existingDestination = nearestExistingPath(destinationPath);
      const resolvedDestination = existingDestination ? realpathSync(existingDestination) : destinationPath;
      return pathInside(root, resolvedDestination) ? 'external_copy_into_workspace' : 'external_write';
    }
    return 'external_write';
  }
  if (program === 'find' && words.some((word) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(word))) return 'external_write';
  if (readOnlyProgram(program)) return 'external_read';
  if (index === 0) return 'unsupported';
  return 'external_write';
}

export function assertCommandPathOperandsStayInRepository(
  command: string,
  cwd: string,
  root: string,
  externalGrants: ExternalFilesystemGrant[] = [],
): RepositoryCommandExternalPathUsage[] {
  const usages: RepositoryCommandExternalPathUsage[] = [];
  for (const segment of shellSegments(command)) {
    const redirectionTarget = segment.match(/(?:^|\s)(?:\d?>?>)\s*(\/[^\s]+)/)?.[1];
    if (redirectionTarget && !redirectionTarget.startsWith('/dev/null')) {
      throw new Error(`COMMAND_SCOPE_DENIED: external writes are not allowed from repository commands: ${redirectionTarget}`);
    }
    const words = shellWords(segment);
    for (let index = 0; index < words.length; index += 1) {
      const token = words[index]!;
      if (!token || token.startsWith('-') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (index === 0) continue;
      const candidateToken = stripTrailingPunctuation(token);
      const absoluteInput = candidateToken.startsWith('/');
      if (!absoluteInput && !/[./\\*?]/.test(candidateToken) && !existsSync(join(cwd, candidateToken))) continue;
      const candidate = absoluteInput ? resolve(candidateToken) : resolve(cwd, candidateToken);
      const existing = nearestExistingPath(candidate);
      if (!existing) continue;
      const resolved = realpathSync(existing);
      if (pathInside(root, resolved)) continue;
      if (!absoluteInput) {
        throw new Error(`COMMAND_SCOPE_DENIED: command operand escapes repository root through a symlink or parent path: ${token}`);
      }
      if (sensitivePathDenied(resolved)) {
        throw new Error(`COMMAND_SCOPE_DENIED: sensitive external path is never allowed in repository commands: ${token}`);
      }
      const operation = operationForToken(words, index, token, cwd, root);
      if (operation === 'external_write') {
        throw new Error(`COMMAND_SCOPE_DENIED: external writes are not allowed from repository commands: ${token}`);
      }
      if (operation === 'unsupported') {
        throw new Error(`COMMAND_SCOPE_DENIED: external path is only allowed for read-only commands or copy-into-repository sources: ${token}`);
      }
      const grant = externalGrants.find((entry) => grantCoversPath(entry, resolved, operation));
      if (!grant) {
        throw new Error(`EXTERNAL_FILESYSTEM_GRANT_REQUIRED: ${operation} requires an active ${operation === 'external_read' ? 'read' : 'copy_into_repo'} grant for ${token}`);
      }
      usages.push({
        token,
        canonicalPath: resolved,
        operation,
        grantKey: grant.key,
        grantRoot: grant.canonicalRoot,
      });
    }
  }
  return usages;
}
