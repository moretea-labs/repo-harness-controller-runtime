import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteFile } from '../../effects/fs-transaction';
import { globMatches, resolveMcpPath } from '../mcp/paths';
import type { McpPolicy } from '../mcp/types';

export type EditSessionStatus = 'open' | 'applied' | 'finalized' | 'rolled_back';

export interface EditSessionOperationRecord {
  type: 'create' | 'write' | 'replace' | 'delete';
  path: string;
  beforeSha256?: string;
  afterSha256?: string;
  backupPath?: string;
  changedLines: number;
}

export interface EditSession {
  schemaVersion: 1;
  sessionId: string;
  issueId?: string;
  taskId?: string;
  purpose: string;
  status: EditSessionStatus;
  allowedPaths: string[];
  maxFiles: number;
  maxChangedLines: number;
  operations: EditSessionOperationRecord[];
  createdAt: string;
  updatedAt: string;
}

export type EditOperation =
  | { type: 'create'; path: string; content: string }
  | { type: 'write'; path: string; expectedSha256: string; content: string }
  | { type: 'replace'; path: string; expectedSha256: string; replacements: Array<{ oldText: string; newText: string; replaceAll?: boolean }> }
  | { type: 'delete'; path: string; expectedSha256: string };

const SESSION_ROOT = '.ai/harness/edit-sessions';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sessionDir(repoRoot: string, sessionId: string): string {
  return join(repoRoot, SESSION_ROOT, sessionId);
}

function sessionPath(repoRoot: string, sessionId: string): string {
  return join(sessionDir(repoRoot, sessionId), 'session.json');
}

function writeSession(repoRoot: string, session: EditSession): void {
  const path = sessionPath(repoRoot, session.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
}

function changedLineEstimate(before: string, after: string): number {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;
  for (let index = 0; index < max; index += 1) if (beforeLines[index] !== afterLines[index]) changed += 1;
  return changed;
}

function pathAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.length === 0 || allowedPaths.some((pattern) => globMatches(pattern, path));
}

export function beginEditSession(repoRoot: string, input: {
  purpose: string;
  issueId?: string;
  taskId?: string;
  allowedPaths?: string[];
  maxFiles?: number;
  maxChangedLines?: number;
}): EditSession {
  const purpose = input.purpose.trim();
  if (!purpose) throw new Error('edit session purpose is required');
  const now = new Date().toISOString();
  const session: EditSession = {
    schemaVersion: 1,
    sessionId: `EDIT-${Date.now()}-${randomBytes(4).toString('hex')}`,
    issueId: input.issueId?.trim() || undefined,
    taskId: input.taskId?.trim() || undefined,
    purpose,
    status: 'open',
    allowedPaths: Array.from(new Set((input.allowedPaths ?? []).map((item) => item.trim()).filter(Boolean))),
    maxFiles: Math.min(Math.max(input.maxFiles ?? 5, 1), 25),
    maxChangedLines: Math.min(Math.max(input.maxChangedLines ?? 300, 1), 5000),
    operations: [],
    createdAt: now,
    updatedAt: now,
  };
  writeSession(repoRoot, session);
  return session;
}

export function getEditSession(repoRoot: string, sessionId: string): EditSession {
  const path = sessionPath(repoRoot, sessionId);
  if (!existsSync(path)) throw new Error(`edit session not found: ${sessionId}`);
  return JSON.parse(readFileSync(path, 'utf-8')) as EditSession;
}

export function applyEditOperations(repoRoot: string, policy: McpPolicy, sessionId: string, operations: EditOperation[]): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (session.status !== 'open') throw new Error(`edit session is not open: ${session.status}`);
  if (operations.length === 0) throw new Error('at least one edit operation is required');
  if (operations.length > session.maxFiles) throw new Error(`operation count exceeds session maxFiles (${session.maxFiles})`);
  const uniquePaths = new Set(operations.map((operation) => operation.path));
  if (uniquePaths.size !== operations.length) throw new Error('each path may appear only once per apply operation');

  const prepared = operations.map((operation) => {
    const decision = resolveMcpPath(repoRoot, operation.path, policy, 'write');
    if (!decision.ok || !decision.absolutePath || !decision.relativePath) throw new Error(decision.reason ?? `path denied: ${operation.path}`);
    if (!pathAllowed(decision.relativePath, session.allowedPaths)) throw new Error(`path is outside edit session scope: ${decision.relativePath}`);
    const exists = existsSync(decision.absolutePath);
    const before = exists ? readFileSync(decision.absolutePath, 'utf-8') : '';
    if (operation.type === 'create') {
      if (exists) throw new Error(`create target already exists: ${decision.relativePath}`);
      return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after: operation.content };
    }
    if (!exists) throw new Error(`target does not exist: ${decision.relativePath}`);
    const beforeHash = hash(before);
    if (beforeHash !== operation.expectedSha256) throw new Error(`stale file version for ${decision.relativePath}: expected ${operation.expectedSha256}, got ${beforeHash}`);
    if (operation.type === 'delete') return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after: '' };
    if (operation.type === 'write') return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after: operation.content };
    let after = before;
    for (const replacement of operation.replacements) {
      if (!replacement.oldText) throw new Error(`replacement oldText is empty for ${decision.relativePath}`);
      if (!after.includes(replacement.oldText)) throw new Error(`replacement text not found in ${decision.relativePath}`);
      after = replacement.replaceAll
        ? after.split(replacement.oldText).join(replacement.newText)
        : after.replace(replacement.oldText, replacement.newText);
    }
    return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after };
  });

  const totalChangedLines = prepared.reduce((sum, item) => sum + changedLineEstimate(item.before, item.after), 0);
  if (totalChangedLines > session.maxChangedLines) throw new Error(`estimated changed lines ${totalChangedLines} exceeds session limit ${session.maxChangedLines}`);

  const records: EditSessionOperationRecord[] = [];
  try {
    for (const item of prepared) {
      const backupRelative = `${SESSION_ROOT}/${session.sessionId}/backups/${item.relativePath.replace(/[^a-zA-Z0-9._-]+/g, '__')}.bak`;
      if (item.operation.type !== 'create') {
        mkdirSync(dirname(join(repoRoot, backupRelative)), { recursive: true });
        writeFileSync(join(repoRoot, backupRelative), item.before, 'utf-8');
      }
      if (item.operation.type === 'delete') rmSync(item.absolutePath);
      else atomicWriteFile(repoRoot, item.relativePath, item.after, { backupRoot: `${SESSION_ROOT}/${session.sessionId}/atomic-backups` });
      records.push({
        type: item.operation.type,
        path: item.relativePath,
        beforeSha256: item.operation.type === 'create' ? undefined : hash(item.before),
        afterSha256: item.operation.type === 'delete' ? undefined : hash(item.after),
        backupPath: item.operation.type === 'create' ? undefined : backupRelative,
        changedLines: changedLineEstimate(item.before, item.after),
      });
    }
  } catch (error) {
    for (const record of [...records].reverse()) {
      const absolute = join(repoRoot, record.path);
      if (record.type === 'create') rmSync(absolute, { force: true });
      else if (record.backupPath && existsSync(join(repoRoot, record.backupPath))) atomicWriteFile(repoRoot, record.path, readFileSync(join(repoRoot, record.backupPath), 'utf-8'));
    }
    throw error;
  }

  session.operations = records;
  session.status = 'applied';
  session.updatedAt = new Date().toISOString();
  writeSession(repoRoot, session);
  return session;
}

export function rollbackEditSession(repoRoot: string, sessionId: string): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (session.status !== 'applied') throw new Error(`only applied sessions can be rolled back (current: ${session.status})`);
  for (const operation of [...session.operations].reverse()) {
    const absolute = join(repoRoot, operation.path);
    if (operation.type === 'create') {
      if (existsSync(absolute)) {
        const current = readFileSync(absolute, 'utf-8');
        if (operation.afterSha256 && hash(current) !== operation.afterSha256) throw new Error(`cannot rollback changed file: ${operation.path}`);
        rmSync(absolute);
      }
      continue;
    }
    if (!operation.backupPath || !existsSync(join(repoRoot, operation.backupPath))) throw new Error(`missing backup for ${operation.path}`);
    if ((operation.type === 'replace' || operation.type === 'write') && existsSync(absolute)) {
      const current = readFileSync(absolute, 'utf-8');
      if (operation.afterSha256 && hash(current) !== operation.afterSha256) throw new Error(`cannot rollback changed file: ${operation.path}`);
    }
    atomicWriteFile(repoRoot, operation.path, readFileSync(join(repoRoot, operation.backupPath), 'utf-8'));
  }
  session.status = 'rolled_back';
  session.updatedAt = new Date().toISOString();
  writeSession(repoRoot, session);
  return session;
}

export function finalizeEditSession(repoRoot: string, sessionId: string): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (session.status !== 'applied') throw new Error(`only applied sessions can be finalized (current: ${session.status})`);
  session.status = 'finalized';
  session.updatedAt = new Date().toISOString();
  writeSession(repoRoot, session);
  return session;
}
