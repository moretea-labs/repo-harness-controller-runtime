import { existsSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type { RepositoryRecord } from './types';

const MAX_COMMAND_LENGTH = 32 * 1024;

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
    [/(?:^|[\s'"=])(?:\.\.(?:\/|\\)|~(?:\/|\\)|[A-Za-z]:[\\/]|\/(?!dev\/null(?:\s|$)))/, 'paths outside the selected repository are not allowed'],
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

export function assertCommandPathOperandsStayInRepository(
  command: string,
  cwd: string,
  root: string,
): void {
  const tokens = command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s;&|<>]+/g) ?? [];
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^['"]|['"]$/g, '');
    if (!token || token.startsWith('-') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (!/[./\\*?]/.test(token) && !existsSync(join(cwd, token))) continue;
    const candidate = resolve(cwd, token.replace(/[,*?]+$/g, ''));
    const existing = nearestExistingPath(candidate);
    if (!existing) continue;
    const resolved = realpathSync(existing);
    if (!pathInside(root, resolved)) {
      throw new Error(`COMMAND_SCOPE_DENIED: command operand escapes repository root: ${token}`);
    }
  }
}
