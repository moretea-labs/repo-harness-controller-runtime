import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { runProcess } from '../../effects/process-runner';
import { globMatches, resolveMcpPath } from '../mcp/paths';
import type { McpPolicy } from '../mcp/types';

const DEFAULT_EXCLUDES = [
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.build/**',
  'DerivedData/**',
  '.ai/harness/backups/**',
  '.ai/harness/edit-sessions/**',
  '.ai/harness/jobs/**',
  '.ai/harness/local-jobs/**',
  '.ai/harness/controller/**',
];

function isExcluded(path: string, excludes: string[]): boolean {
  return excludes.some((pattern) => globMatches(pattern, path));
}

function isIncluded(path: string, includes: string[]): boolean {
  return includes.length === 0 || includes.some((pattern) => globMatches(pattern, path));
}

function binary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0);
}

function walk(repoRoot: string, root: string, maxFiles: number, excludes: string[], output: string[]): void {
  if (output.length >= maxFiles) return;
  const absolute = join(repoRoot, root);
  if (!existsSync(absolute)) return;
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) return;
  if (info.isFile()) {
    output.push(root);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (output.length >= maxFiles) break;
    const child = root ? `${root}/${entry.name}` : entry.name;
    if (isExcluded(child, excludes) || isExcluded(`${child}/`, excludes)) continue;
    if (entry.isDirectory()) walk(repoRoot, child, maxFiles, excludes, output);
    else if (entry.isFile()) output.push(child);
  }
}

export interface SearchRepositoryOptions {
  query: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxResults?: number;
  maxFiles?: number;
  caseSensitive?: boolean;
}

export function searchRepository(repoRoot: string, policy: McpPolicy, opts: SearchRepositoryOptions): {
  query: string;
  results: Array<{ path: string; line: number; text: string }>;
  scannedFiles: number;
  truncated: boolean;
} {
  const query = opts.query;
  if (!query.trim()) throw new Error('search query is required');
  const maxResults = Math.min(Math.max(opts.maxResults ?? 100, 1), 500);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 5000, 1), 20_000);
  const includes = opts.includeGlobs ?? [];
  const excludes = [...DEFAULT_EXCLUDES, ...(opts.excludeGlobs ?? [])];
  const files: string[] = [];
  walk(repoRoot, '', maxFiles, excludes, files);
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  const results: Array<{ path: string; line: number; text: string }> = [];
  let scannedFiles = 0;
  for (const path of files) {
    if (results.length >= maxResults) break;
    if (!isIncluded(path, includes) || isExcluded(path, excludes)) continue;
    const decision = resolveMcpPath(repoRoot, path, policy, 'read');
    if (!decision.ok || !decision.absolutePath) continue;
    const size = statSync(decision.absolutePath).size;
    if (size > policy.maxFileBytes) continue;
    const bytes = readFileSync(decision.absolutePath);
    if (binary(bytes)) continue;
    scannedFiles += 1;
    const raw = bytes.toString('utf-8');
  const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
      const haystack = opts.caseSensitive ? lines[index] : lines[index].toLowerCase();
      if (haystack.includes(needle)) results.push({ path, line: index + 1, text: lines[index].slice(0, 500) });
    }
  }
  return { query, results, scannedFiles, truncated: results.length >= maxResults || files.length >= maxFiles };
}

export function readRepositoryRange(repoRoot: string, policy: McpPolicy, path: string, startLine = 1, endLine = startLine + 199): {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  sha256: string;
} {
  const decision = resolveMcpPath(repoRoot, path, policy, 'read');
  if (!decision.ok || !decision.absolutePath || !decision.relativePath) throw new Error(decision.reason ?? 'path denied');
  const info = statSync(decision.absolutePath);
  if (!info.isFile()) throw new Error(`path is not a file: ${decision.relativePath}`);
  if (info.size > policy.maxFileBytes) throw new Error(`file exceeds ${policy.maxFileBytes} bytes`);
  const bytes = readFileSync(decision.absolutePath);
  if (binary(bytes)) throw new Error('binary files are not supported');
  const raw = bytes.toString('utf-8');
  const lines = raw.split(/\r?\n/);
  const start = Math.min(Math.max(Math.trunc(startLine), 1), Math.max(lines.length, 1));
  const end = Math.min(Math.max(Math.trunc(endLine), start), lines.length);
  return {
    path: decision.relativePath,
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
    content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n'),
  };
}

export function gitSnapshot(repoRoot: string): { branch: string | null; status: string; diffStat: string } {
  const branchResult = runProcess('git', ['branch', '--show-current'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 32 * 1024 });
  const statusResult = runProcess('git', ['status', '--short', '--branch'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const diffResult = runProcess('git', ['diff', '--stat'], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  return {
    branch: branchResult.ok ? branchResult.stdout.trim() || null : null,
    status: statusResult.ok ? statusResult.stdout.trim() : statusResult.error || statusResult.stderr.trim(),
    diffStat: diffResult.ok ? diffResult.stdout.trim() : diffResult.error || diffResult.stderr.trim(),
  };
}

export function gitDiff(repoRoot: string, path?: string, maxBytes = 128 * 1024): { path?: string; diff: string; truncated: boolean } {
  const args = ['diff', '--'];
  if (path?.trim()) args.push(path.trim());
  const result = runProcess('git', args, { cwd: repoRoot, timeoutMs: 20_000, maxOutputBytes: maxBytes });
  if (!result.ok && result.status !== 0) throw new Error(result.error || result.stderr || 'git diff failed');
  return { path: path?.trim() || undefined, diff: result.stdout, truncated: result.stdout.length >= maxBytes };
}
