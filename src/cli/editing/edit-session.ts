import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { atomicWriteFile } from '../../effects/fs-transaction';
import { runProcess } from '../../effects/process-runner';
import { runControllerCheck, type ControllerCheckResult } from '../controller/check-runner';
import { tryAppendControllerWorklogEvent } from '../controller/worklog';
import { globMatches, resolveMcpPath } from '../mcp/paths';
import type { McpPolicy } from '../mcp/types';

export type EditSessionStatus =
  | 'open'
  | 'applied'
  | 'verified'
  | 'verification_failed'
  | 'finalized'
  | 'rolled_back';

export interface EditSessionOperationRecord {
  type: 'create' | 'write' | 'replace' | 'delete';
  path: string;
  beforeSha256?: string;
  afterSha256?: string;
  backupPath?: string;
  changedLines: number;
}

export interface EditSessionCheckRecord {
  checkId: string;
  ok: boolean;
  summary: string;
  artifactPath?: string;
  executedAt: string;
}

export interface EditSession {
  schemaVersion: 2;
  sessionId: string;
  issueId?: string;
  taskId?: string;
  purpose: string;
  status: EditSessionStatus;
  allowedPaths: string[];
  maxFiles: number;
  maxChangedLines: number;
  requestedChecks: string[];
  operations: EditSessionOperationRecord[];
  checkResults: EditSessionCheckRecord[];
  baseRevision?: string;
  diffPath?: string;
  diffSha256?: string;
  reviewer?: string;
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  verifiedAt?: string;
  finalizedAt?: string;
  rolledBackAt?: string;
}

export interface EditSessionSummary {
  sessionId: string;
  purpose: string;
  status: EditSessionStatus;
  issueId?: string;
  taskId?: string;
  changedFiles: number;
  changedLines: number;
  checksPassed: number;
  checksTotal: number;
  baseRevision?: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
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

function now(): string {
  return new Date().toISOString();
}

function sessionDir(repoRoot: string, sessionId: string): string {
  return join(repoRoot, SESSION_ROOT, sessionId);
}

function sessionPath(repoRoot: string, sessionId: string): string {
  return join(sessionDir(repoRoot, sessionId), 'session.json');
}

function diffPath(repoRoot: string, sessionId: string): string {
  return join(sessionDir(repoRoot, sessionId), 'changes.patch');
}

function writeSession(repoRoot: string, session: EditSession): void {
  const path = sessionPath(repoRoot, session.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
}

function normalizeStoredSession(value: Partial<EditSession> & { sessionId: string }): EditSession {
  return {
    schemaVersion: 2,
    sessionId: value.sessionId,
    issueId: value.issueId,
    taskId: value.taskId,
    purpose: value.purpose ?? 'Direct edit',
    status: value.status ?? 'open',
    allowedPaths: value.allowedPaths ?? [],
    maxFiles: value.maxFiles ?? 5,
    maxChangedLines: value.maxChangedLines ?? 300,
    requestedChecks: value.requestedChecks ?? [],
    operations: value.operations ?? [],
    checkResults: value.checkResults ?? [],
    baseRevision: value.baseRevision,
    diffPath: value.diffPath,
    diffSha256: value.diffSha256,
    reviewer: value.reviewer,
    reviewNote: value.reviewNote,
    createdAt: value.createdAt ?? now(),
    updatedAt: value.updatedAt ?? value.createdAt ?? now(),
    appliedAt: value.appliedAt,
    verifiedAt: value.verifiedAt,
    finalizedAt: value.finalizedAt,
    rolledBackAt: value.rolledBackAt,
  };
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

function gitRevision(repoRoot: string): string | undefined {
  const result = runProcess('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeoutMs: 5_000 });
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

function patchLines(value: string, prefix: string): string[] {
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => `${prefix}${line}`);
}

function buildUnifiedPatch(items: Array<{
  operation: EditOperation;
  relativePath: string;
  before: string;
  after: string;
}>): string {
  const output: string[] = [];
  for (const item of items) {
    const beforeCount = item.before ? item.before.split(/\r?\n/).filter((_, index, list) => index < list.length - 1 || list[index] !== '').length : 0;
    const afterCount = item.after ? item.after.split(/\r?\n/).filter((_, index, list) => index < list.length - 1 || list[index] !== '').length : 0;
    const oldPath = item.operation.type === 'create' ? '/dev/null' : `a/${item.relativePath}`;
    const newPath = item.operation.type === 'delete' ? '/dev/null' : `b/${item.relativePath}`;
    output.push(`diff --git a/${item.relativePath} b/${item.relativePath}`);
    output.push(`--- ${oldPath}`);
    output.push(`+++ ${newPath}`);
    output.push(`@@ -1,${beforeCount} +1,${afterCount} @@`);
    output.push(...patchLines(item.before, '-'));
    output.push(...patchLines(item.after, '+'));
  }
  return `${output.join('\n')}\n`;
}

function assertCurrentHashes(repoRoot: string, session: EditSession): void {
  for (const operation of session.operations) {
    const absolute = join(repoRoot, operation.path);
    if (operation.type === 'delete') {
      if (existsSync(absolute)) throw new Error(`deleted file was recreated after apply: ${operation.path}`);
      continue;
    }
    if (!existsSync(absolute)) throw new Error(`applied file is missing: ${operation.path}`);
    const current = readFileSync(absolute, 'utf-8');
    if (operation.afterSha256 && hash(current) !== operation.afterSha256) {
      throw new Error(`applied file changed outside the edit session: ${operation.path}`);
    }
  }
}

function checkRecord(result: ControllerCheckResult): EditSessionCheckRecord {
  return {
    checkId: result.check.id,
    ok: result.ok,
    summary: result.ok
      ? `Passed: ${result.command.join(' ')}`
      : `Failed (${result.status}${result.timedOut ? ', timeout' : ''}): ${(result.stderr || result.stdout).slice(0, 500)}`,
    artifactPath: result.artifactPath,
    executedAt: result.executedAt,
  };
}

function sessionSummary(session: EditSession): EditSessionSummary {
  return {
    sessionId: session.sessionId,
    purpose: session.purpose,
    status: session.status,
    issueId: session.issueId,
    taskId: session.taskId,
    changedFiles: session.operations.length,
    changedLines: session.operations.reduce((sum, operation) => sum + operation.changedLines, 0),
    checksPassed: session.checkResults.filter((result) => result.ok).length,
    checksTotal: session.checkResults.length || session.requestedChecks.length,
    baseRevision: session.baseRevision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    finalizedAt: session.finalizedAt,
  };
}

export function beginEditSession(repoRoot: string, input: {
  purpose: string;
  issueId?: string;
  taskId?: string;
  allowedPaths?: string[];
  maxFiles?: number;
  maxChangedLines?: number;
  checks?: string[];
}): EditSession {
  const purpose = input.purpose.trim();
  if (!purpose) throw new Error('edit session purpose is required');
  const at = now();
  const session: EditSession = {
    schemaVersion: 2,
    sessionId: `EDIT-${Date.now()}-${randomBytes(4).toString('hex')}`,
    issueId: input.issueId?.trim() || undefined,
    taskId: input.taskId?.trim() || undefined,
    purpose,
    status: 'open',
    allowedPaths: Array.from(new Set((input.allowedPaths ?? []).map((item) => item.trim()).filter(Boolean))),
    maxFiles: Math.min(Math.max(input.maxFiles ?? 5, 1), 25),
    maxChangedLines: Math.min(Math.max(input.maxChangedLines ?? 300, 1), 5000),
    requestedChecks: Array.from(new Set((input.checks ?? []).map((item) => item.trim()).filter(Boolean))),
    operations: [],
    checkResults: [],
    baseRevision: gitRevision(repoRoot),
    createdAt: at,
    updatedAt: at,
  };
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: 'edit_session_started',
    summary: purpose,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { allowedPaths: session.allowedPaths, requestedChecks: session.requestedChecks },
  });
  return session;
}

export function getEditSession(repoRoot: string, sessionId: string): EditSession {
  const path = sessionPath(repoRoot, sessionId);
  if (!existsSync(path)) throw new Error(`edit session not found: ${sessionId}`);
  return normalizeStoredSession(JSON.parse(readFileSync(path, 'utf-8')) as Partial<EditSession> & { sessionId: string });
}

export function listEditSessions(repoRoot: string, limit = 100): EditSessionSummary[] {
  const root = join(repoRoot, SESSION_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'session.json')))
    .flatMap((entry) => {
      try {
        return [sessionSummary(getEditSession(repoRoot, entry.name))];
      } catch (_error) {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

export function getEditSessionDiff(repoRoot: string, sessionId: string): {
  sessionId: string;
  path?: string;
  sha256?: string;
  patch: string;
} {
  const session = getEditSession(repoRoot, sessionId);
  const path = session.diffPath ? join(repoRoot, session.diffPath) : diffPath(repoRoot, sessionId);
  const patch = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  return { sessionId, path: session.diffPath, sha256: session.diffSha256, patch };
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
  const noChange = prepared.filter((item) => item.before === item.after).map((item) => item.relativePath);
  if (noChange.length) throw new Error(`edit operation produced no change: ${noChange.join(', ')}`);

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

  const patch = buildUnifiedPatch(prepared);
  const absoluteDiffPath = diffPath(repoRoot, session.sessionId);
  mkdirSync(dirname(absoluteDiffPath), { recursive: true });
  writeFileSync(absoluteDiffPath, patch, 'utf-8');

  session.operations = records;
  session.status = 'applied';
  session.appliedAt = now();
  session.updatedAt = session.appliedAt;
  session.diffPath = relative(repoRoot, absoluteDiffPath).replace(/\\/g, '/');
  session.diffSha256 = hash(patch);
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: 'edit_session_applied',
    summary: `${session.purpose}: ${records.length} file(s), ${totalChangedLines} changed line(s)`,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { files: records.map((record) => record.path), diffPath: session.diffPath, diffSha256: session.diffSha256 },
  });
  return session;
}

export function verifyEditSession(repoRoot: string, sessionId: string, input: {
  checkIds?: string[];
  reviewer?: string;
  note?: string;
} = {}): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (!['applied', 'verification_failed', 'verified'].includes(session.status)) {
    throw new Error(`edit session cannot be verified from ${session.status}`);
  }
  assertCurrentHashes(repoRoot, session);
  const checkIds = Array.from(new Set((input.checkIds ?? session.requestedChecks).map((item) => item.trim()).filter(Boolean)));
  const results = checkIds.map((checkId) => {
    try {
      return checkRecord(runControllerCheck(repoRoot, checkId));
    } catch (error) {
      return {
        checkId,
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        executedAt: now(),
      } satisfies EditSessionCheckRecord;
    }
  });
  const reviewer = input.reviewer?.trim() || 'repo-harness-controller';
  const at = now();
  session.requestedChecks = checkIds;
  session.checkResults = results;
  session.reviewer = reviewer;
  session.reviewNote = input.note?.trim() || undefined;
  session.verifiedAt = results.every((result) => result.ok) ? at : undefined;
  session.status = results.every((result) => result.ok) ? 'verified' : 'verification_failed';
  session.updatedAt = at;
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: session.status === 'verified' ? 'edit_session_verified' : 'edit_session_verification_failed',
    summary: `${session.purpose}: ${results.filter((result) => result.ok).length}/${results.length} checks passed${results.length === 0 ? '; explicit review recorded' : ''}`,
    actor: reviewer,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { checkResults: results, note: session.reviewNote },
  });
  return session;
}

export function rollbackEditSession(repoRoot: string, sessionId: string): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (!['applied', 'verified', 'verification_failed'].includes(session.status)) {
    throw new Error(`only non-finalized applied sessions can be rolled back (current: ${session.status})`);
  }
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
  session.rolledBackAt = now();
  session.updatedAt = session.rolledBackAt;
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: 'edit_session_rolled_back',
    summary: session.purpose,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { files: session.operations.map((operation) => operation.path) },
  });
  return session;
}

export function finalizeEditSession(repoRoot: string, sessionId: string, input: {
  reviewer?: string;
  note?: string;
} = {}): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (session.status !== 'verified') {
    throw new Error(`edit session must be verified before finalization (current: ${session.status})`);
  }
  assertCurrentHashes(repoRoot, session);
  session.status = 'finalized';
  session.reviewer = input.reviewer?.trim() || session.reviewer || 'repo-harness-controller';
  session.reviewNote = input.note?.trim() || session.reviewNote;
  session.finalizedAt = now();
  session.updatedAt = session.finalizedAt;
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: 'edit_session_finalized',
    summary: `${session.purpose}: ${session.operations.length} file(s) finalized`,
    actor: session.reviewer,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: {
      files: session.operations.map((operation) => operation.path),
      diffPath: session.diffPath,
      diffSha256: session.diffSha256,
      checkResults: session.checkResults,
      note: session.reviewNote,
    },
  });
  return session;
}
