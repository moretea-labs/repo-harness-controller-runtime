import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { atomicWriteFile } from '../../effects/fs-transaction';
import { runProcess } from '../../effects/process-runner';
import {
  runControllerCheck,
  runControllerCheckAsync,
  type ControllerCheckResult,
} from '../controller/check-runner';
import { tryAppendControllerWorklogEvent } from '../controller/worklog';
import { globMatches, resolveMcpPath } from '../mcp/paths';
import type { McpPolicy } from '../mcp/types';

export type EditSessionStatus =
  | 'open'
  | 'dirty'
  | 'checked'
  | 'check_failed'
  | 'finalized'
  | 'rolled_back';

export interface EditSessionOperationRecord {
  revision: number;
  operationIndex: number;
  type: 'create' | 'write' | 'replace' | 'insert_before' | 'insert_after' | 'prepend' | 'append' | 'delete';
  path: string;
  beforeSha256?: string;
  afterSha256?: string;
  backupPath?: string;
  changedLines: number;
}

export interface EditSessionRevision {
  revision: number;
  operations: EditSessionOperationRecord[];
  changedFiles: number;
  changedLines: number;
  patchPath: string;
  patchSha256: string;
  createdAt: string;
}

export interface EditSessionSavepoint {
  name: string;
  revision: number;
  createdAt: string;
}

export interface EditSessionCheckRecord {
  checkId: string;
  ok: boolean;
  summary: string;
  artifactPath?: string;
  executedAt: string;
}

export interface EditSession {
  schemaVersion: 3;
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
  revisions: EditSessionRevision[];
  savepoints: EditSessionSavepoint[];
  currentRevision: number;
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
  revisionCount: number;
  currentRevision: number;
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
  | { type: 'insert_before' | 'insert_after'; path: string; expectedSha256: string; anchor: string; content: string; occurrence?: number }
  | { type: 'prepend' | 'append'; path: string; expectedSha256: string; content: string }
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

function revisionPatchPath(repoRoot: string, sessionId: string, revision: number): string {
  return join(sessionDir(repoRoot, sessionId), 'revisions', `${String(revision).padStart(4, '0')}.patch`);
}

function writeSession(repoRoot: string, session: EditSession): void {
  const path = sessionPath(repoRoot, session.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
}

function normalizeLegacyStatus(value: unknown): EditSessionStatus {
  if (value === 'applied') return 'dirty';
  if (value === 'verified') return 'checked';
  if (value === 'verification_failed') return 'check_failed';
  if (['open', 'dirty', 'checked', 'check_failed', 'finalized', 'rolled_back'].includes(String(value))) {
    return String(value) as EditSessionStatus;
  }
  return 'open';
}

function normalizeStoredSession(value: Partial<EditSession> & { sessionId: string }): EditSession {
  const legacyOperations = (value.operations ?? []).map((operation, index) => ({
    ...operation,
    revision: operation.revision ?? 1,
    operationIndex: operation.operationIndex ?? index + 1,
  })) as EditSessionOperationRecord[];
  const inferredRevision = legacyOperations.reduce((max, operation) => Math.max(max, operation.revision), 0);
  const legacyRevision = inferredRevision > 0 && (value.revisions ?? []).length === 0
    ? [{
        revision: inferredRevision,
        operations: legacyOperations,
        changedFiles: new Set(legacyOperations.map((operation) => operation.path)).size,
        changedLines: legacyOperations.reduce((sum, operation) => sum + operation.changedLines, 0),
        patchPath: value.diffPath ?? `${SESSION_ROOT}/${value.sessionId}/changes.patch`,
        patchSha256: value.diffSha256 ?? '',
        createdAt: value.appliedAt ?? value.updatedAt ?? value.createdAt ?? now(),
      }]
    : [];
  return {
    schemaVersion: 3,
    sessionId: value.sessionId,
    issueId: value.issueId,
    taskId: value.taskId,
    purpose: value.purpose ?? 'Direct edit',
    status: normalizeLegacyStatus(value.status),
    allowedPaths: value.allowedPaths ?? [],
    maxFiles: value.maxFiles ?? 100,
    maxChangedLines: value.maxChangedLines ?? 50_000,
    requestedChecks: value.requestedChecks ?? [],
    operations: legacyOperations,
    revisions: value.revisions ?? legacyRevision,
    savepoints: value.savepoints ?? [],
    currentRevision: value.currentRevision ?? inferredRevision,
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
  if (before === after) return 0;
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const removed = beforeLines.length - prefix - suffix;
  const added = afterLines.length - prefix - suffix;
  return Math.max(removed, added);
}

function changedLinesByPathFromPatch(patch: string): Map<string, number> {
  const changedLines = new Map<string, number>();
  let currentPath: string | undefined;
  let inHunk = false;
  let removed = 0;
  let added = 0;

  const flushBlock = () => {
    if (currentPath && (removed > 0 || added > 0)) {
      changedLines.set(
        currentPath,
        (changedLines.get(currentPath) ?? 0) + Math.max(removed, added),
      );
    }
    removed = 0;
    added = 0;
  };

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushBlock();
      inHunk = false;
      const newPathMarker = line.lastIndexOf(' b/');
      currentPath = newPathMarker >= 0 ? line.slice(newPathMarker + 3) : undefined;
      continue;
    }
    if (line.startsWith('@@ ')) {
      flushBlock();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('-')) {
      removed += 1;
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) continue;
    flushBlock();
  }
  flushBlock();
  return changedLines;
}

function pathAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.length === 0 || allowedPaths.some((pattern) => globMatches(pattern, path));
}

function gitRevision(repoRoot: string): string | undefined {
  const result = runProcess('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeoutMs: 5_000 });
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

function latestOperations(session: EditSession): Map<string, EditSessionOperationRecord> {
  const latest = new Map<string, EditSessionOperationRecord>();
  for (const operation of session.operations) latest.set(operation.path, operation);
  return latest;
}

function assertCurrentHashes(repoRoot: string, session: EditSession): void {
  for (const operation of latestOperations(session).values()) {
    const absolute = join(repoRoot, operation.path);
    if (operation.type === 'delete') {
      if (existsSync(absolute)) throw new Error(`deleted file was recreated after edit revision ${operation.revision}: ${operation.path}`);
      continue;
    }
    if (!existsSync(absolute)) throw new Error(`edited file is missing: ${operation.path}`);
    const current = readFileSync(absolute, 'utf-8');
    if (operation.afterSha256 && hash(current) !== operation.afterSha256) {
      throw new Error(`edited file changed outside the session after revision ${operation.revision}: ${operation.path}`);
    }
  }
}

interface PatchItem {
  relativePath: string;
  before: string;
  after: string;
  beforeExists: boolean;
  afterExists: boolean;
}

function normalizeNoIndexPatch(raw: string, item: PatchItem): string {
  const lines = raw.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ''));
  if (lines.length === 0) return '';
  const diffIndex = lines.findIndex((line) => line.startsWith('diff --git '));
  const normalized = (diffIndex >= 0 ? lines.slice(diffIndex) : lines).map((line) => line);
  const oldPath = item.beforeExists ? `a/${item.relativePath}` : '/dev/null';
  const newPath = item.afterExists ? `b/${item.relativePath}` : '/dev/null';
  const header = normalized.findIndex((line) => line.startsWith('diff --git '));
  if (header >= 0) normalized[header] = `diff --git a/${item.relativePath} b/${item.relativePath}`;
  const oldHeader = normalized.findIndex((line) => line.startsWith('--- '));
  const newHeader = normalized.findIndex((line) => line.startsWith('+++ '));
  if (oldHeader >= 0) normalized[oldHeader] = `--- ${oldPath}`;
  if (newHeader >= 0) normalized[newHeader] = `+++ ${newPath}`;
  if (header >= 0 && !item.beforeExists && !normalized.some((line) => line.startsWith('new file mode '))) {
    normalized.splice(header + 1, 0, 'new file mode 100644');
  }
  if (header >= 0 && !item.afterExists && !normalized.some((line) => line.startsWith('deleted file mode '))) {
    normalized.splice(header + 1, 0, 'deleted file mode 100644');
  }
  return `${normalized.join('\n')}\n`;
}

function buildLocalizedPatch(repoRoot: string, sessionId: string, label: string, items: PatchItem[]): string {
  const patchItems = items.filter((item) => item.beforeExists !== item.afterExists || item.before !== item.after);
  if (patchItems.length === 0) return '';
  const tempRoot = join(sessionDir(repoRoot, sessionId), 'diff-inputs', label);
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  const parts: string[] = [];
  try {
    patchItems.forEach((item, index) => {
      const prefix = `${String(index + 1).padStart(4, '0')}-${item.relativePath.replace(/[^a-zA-Z0-9._-]+/g, '__')}`;
      const beforePath = join(tempRoot, `${prefix}.before`);
      const afterPath = join(tempRoot, `${prefix}.after`);
      writeFileSync(beforePath, item.before, 'utf-8');
      writeFileSync(afterPath, item.after, 'utf-8');
      const result = runProcess('git', ['diff', '--no-index', '--text', '--unified=3', '--', beforePath, afterPath], {
        cwd: repoRoot,
        timeoutMs: 15_000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (![0, 1].includes(result.status) || result.timedOut) {
        throw new Error(`failed to build localized patch for ${item.relativePath}: ${result.stderr || result.error}`);
      }
      const normalized = normalizeNoIndexPatch(result.stdout, item);
      if (normalized) parts.push(normalized.trimEnd());
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return parts.length > 0 ? `${parts.join('\n')}\n` : '';
}

function baselinePatchItems(repoRoot: string, session: EditSession): PatchItem[] {
  const firstByPath = new Map<string, EditSessionOperationRecord>();
  for (const operation of session.operations) if (!firstByPath.has(operation.path)) firstByPath.set(operation.path, operation);
  return [...firstByPath.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, first]) => {
    const beforeExists = first.type !== 'create';
    const before = beforeExists && first.backupPath && existsSync(join(repoRoot, first.backupPath))
      ? readFileSync(join(repoRoot, first.backupPath), 'utf-8')
      : '';
    const absolute = join(repoRoot, path);
    const afterExists = existsSync(absolute);
    const after = afterExists ? readFileSync(absolute, 'utf-8') : '';
    return { relativePath: path, before, after, beforeExists, afterExists };
  });
}

function persistAggregatePatchContent(repoRoot: string, session: EditSession, patch: string): void {
  const absoluteDiffPath = diffPath(repoRoot, session.sessionId);
  mkdirSync(dirname(absoluteDiffPath), { recursive: true });
  writeFileSync(absoluteDiffPath, patch, 'utf-8');
  session.diffPath = relative(repoRoot, absoluteDiffPath).replace(/\\/g, '/');
  session.diffSha256 = hash(patch);
}

function persistAggregatePatch(repoRoot: string, session: EditSession): void {
  const patch = buildLocalizedPatch(repoRoot, session.sessionId, 'aggregate', baselinePatchItems(repoRoot, session));
  persistAggregatePatchContent(repoRoot, session, patch);
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

function resolveVerificationRequest(repoRoot: string, sessionId: string, input: {
  checkIds?: string[];
  reviewer?: string;
  note?: string;
} = {}): {
  session: EditSession;
  checkIds: string[];
  reviewer: string;
  note?: string;
} {
  const session = getEditSession(repoRoot, sessionId);
  if (!['dirty', 'check_failed', 'checked'].includes(session.status)) {
    throw new Error(`edit session cannot be checked from ${session.status}`);
  }
  assertCurrentHashes(repoRoot, session);
  return {
    session,
    checkIds: Array.from(new Set((input.checkIds ?? session.requestedChecks).map((item) => item.trim()).filter(Boolean))),
    reviewer: input.reviewer?.trim() || 'chatgpt-controller',
    note: input.note?.trim() || undefined,
  };
}

function persistVerificationResult(
  repoRoot: string,
  session: EditSession,
  input: {
    checkIds: string[];
    reviewer: string;
    note?: string;
    results: EditSessionCheckRecord[];
  },
): EditSession {
  const at = now();
  session.requestedChecks = input.checkIds;
  session.checkResults = input.results;
  session.reviewer = input.reviewer;
  session.reviewNote = input.note;
  session.verifiedAt = input.results.every((result) => result.ok) ? at : undefined;
  session.status = input.results.every((result) => result.ok) ? 'checked' : 'check_failed';
  session.updatedAt = at;
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: session.status === 'checked' ? 'edit_session_checked' : 'edit_session_check_failed',
    summary: `${session.purpose}: ${input.results.filter((result) => result.ok).length}/${input.results.length} checks passed${input.results.length === 0 ? '; no checks were required' : ''}`,
    actor: input.reviewer,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { revision: session.currentRevision, checkResults: input.results, note: session.reviewNote },
  });
  return session;
}

function sessionSummary(session: EditSession): EditSessionSummary {
  return {
    sessionId: session.sessionId,
    purpose: session.purpose,
    status: session.status,
    issueId: session.issueId,
    taskId: session.taskId,
    changedFiles: new Set(session.operations.map((operation) => operation.path)).size,
    changedLines: session.operations.reduce((sum, operation) => sum + operation.changedLines, 0),
    revisionCount: session.revisions.length,
    currentRevision: session.currentRevision,
    checksPassed: session.checkResults.filter((result) => result.ok).length,
    checksTotal: session.checkResults.length || session.requestedChecks.length,
    baseRevision: session.baseRevision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    finalizedAt: session.finalizedAt,
  };
}

function findOccurrence(value: string, anchor: string, occurrence: number): number {
  let from = 0;
  for (let current = 1; current <= occurrence; current += 1) {
    const index = value.indexOf(anchor, from);
    if (index < 0) return -1;
    if (current === occurrence) return index;
    from = index + anchor.length;
  }
  return -1;
}

function applyTextOperation(operation: Exclude<EditOperation, { type: 'create' | 'write' | 'delete' }>, before: string, path: string): string {
  if (operation.type === 'replace') {
    let after = before;
    for (const replacement of operation.replacements) {
      if (!replacement.oldText) throw new Error(`replacement oldText is empty for ${path}`);
      if (!after.includes(replacement.oldText)) throw new Error(`replacement text not found in ${path}`);
      after = replacement.replaceAll
        ? after.split(replacement.oldText).join(replacement.newText)
        : after.replace(replacement.oldText, replacement.newText);
    }
    return after;
  }
  if (operation.type === 'prepend') return `${operation.content}${before}`;
  if (operation.type === 'append') return `${before}${operation.content}`;
  if (!("anchor" in operation) || !operation.anchor) throw new Error(`anchor is empty for ${path}`);
  const occurrence = Math.max(1, Math.trunc(operation.occurrence ?? 1));
  const index = findOccurrence(before, operation.anchor, occurrence);
  if (index < 0) throw new Error(`anchor occurrence ${occurrence} not found in ${path}`);
  const insertion = operation.type === 'insert_before' ? index : index + operation.anchor.length;
  return `${before.slice(0, insertion)}${operation.content}${before.slice(insertion)}`;
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
    schemaVersion: 3,
    sessionId: `EDIT-${Date.now()}-${randomBytes(4).toString('hex')}`,
    issueId: input.issueId?.trim() || undefined,
    taskId: input.taskId?.trim() || undefined,
    purpose,
    status: 'open',
    allowedPaths: Array.from(new Set((input.allowedPaths ?? []).map((item) => item.trim()).filter(Boolean))),
    maxFiles: Math.min(Math.max(input.maxFiles ?? 100, 1), 1_000),
    maxChangedLines: Math.min(Math.max(input.maxChangedLines ?? 50_000, 1), 500_000),
    requestedChecks: Array.from(new Set((input.checks ?? []).map((item) => item.trim()).filter(Boolean))),
    operations: [],
    revisions: [],
    savepoints: [],
    currentRevision: 0,
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
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'session.json')))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, boundedLimit)
    .flatMap((entry) => {
      try {
        return [sessionSummary(getEditSession(repoRoot, entry.name))];
      } catch (_error) {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getEditSessionDiff(repoRoot: string, sessionId: string): {
  sessionId: string;
  path?: string;
  sha256?: string;
  revision: number;
  patch: string;
} {
  const session = getEditSession(repoRoot, sessionId);
  const path = session.diffPath ? join(repoRoot, session.diffPath) : diffPath(repoRoot, sessionId);
  const patch = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  return { sessionId, path: session.diffPath, sha256: session.diffSha256, revision: session.currentRevision, patch };
}

export function applyEditOperations(repoRoot: string, policy: McpPolicy, sessionId: string, operations: EditOperation[]): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (['finalized', 'rolled_back'].includes(session.status)) throw new Error(`edit session is closed: ${session.status}`);
  if (operations.length === 0) throw new Error('at least one edit operation is required');
  if (operations.length > 500) throw new Error('one patch batch may contain at most 500 operations');
  const uniquePaths = new Set(operations.map((operation) => operation.path));
  if (uniquePaths.size !== operations.length) throw new Error('each path may appear only once per patch batch');
  assertCurrentHashes(repoRoot, session);

  const cumulativePaths = new Set([...session.operations.map((operation) => operation.path), ...operations.map((operation) => operation.path)]);
  if (cumulativePaths.size > session.maxFiles) throw new Error(`changed file count ${cumulativePaths.size} exceeds session maxFiles (${session.maxFiles})`);

  const prepared = operations.map((operation) => {
    const decision = resolveMcpPath(repoRoot, operation.path, policy, 'write');
    if (!decision.ok || !decision.absolutePath || !decision.relativePath) throw new Error(decision.reason ?? `path denied: ${operation.path}`);
    if (!pathAllowed(decision.relativePath, session.allowedPaths)) throw new Error(`path is outside edit session scope: ${decision.relativePath}`);
    const exists = existsSync(decision.absolutePath);
    const before = exists ? readFileSync(decision.absolutePath, 'utf-8') : '';
    if (operation.type === 'create') {
      if (exists) throw new Error(`create target already exists: ${decision.relativePath}`);
      return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after: operation.content, beforeExists: false, afterExists: true };
    }
    if (!exists) throw new Error(`target does not exist: ${decision.relativePath}`);
    const beforeHash = hash(before);
    if (beforeHash !== operation.expectedSha256) throw new Error(`stale file version for ${decision.relativePath}: expected ${operation.expectedSha256}, got ${beforeHash}`);
    if (operation.type === 'delete') return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after: '', beforeExists: true, afterExists: false };
    if (operation.type === 'write') return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after: operation.content, beforeExists: true, afterExists: true };
    const after = applyTextOperation(operation, before, decision.relativePath);
    return { operation, relativePath: decision.relativePath, absolutePath: decision.absolutePath, before, after, beforeExists: true, afterExists: true };
  });

  const noChange = prepared.filter((item) => item.beforeExists === item.afterExists && item.before === item.after).map((item) => item.relativePath);
  if (noChange.length) throw new Error(`edit operation produced no change: ${noChange.join(', ')}`);

  const revision = session.currentRevision + 1;
  const revisionPatch = buildLocalizedPatch(repoRoot, session.sessionId, `revision-${revision}`, prepared.map((item) => ({
    relativePath: item.relativePath,
    before: item.before,
    after: item.after,
    beforeExists: item.beforeExists,
    afterExists: item.afterExists,
  })));
  const changedLinesByPath = changedLinesByPathFromPatch(revisionPatch);
  const changedLinesFor = (item: typeof prepared[number]) =>
    changedLinesByPath.get(item.relativePath) ?? changedLineEstimate(item.before, item.after);
  const batchChangedLines = prepared.reduce((sum, item) => sum + changedLinesFor(item), 0);
  const cumulativeChangedLines = session.operations.reduce((sum, operation) => sum + operation.changedLines, 0) + batchChangedLines;
  if (cumulativeChangedLines > session.maxChangedLines) throw new Error(`estimated cumulative changed lines ${cumulativeChangedLines} exceeds session limit ${session.maxChangedLines}`);

  const firstRevision = session.operations.length === 0;
  const records: EditSessionOperationRecord[] = [];
  try {
    prepared.forEach((item, index) => {
      const backupRelative = `${SESSION_ROOT}/${session.sessionId}/backups/r${String(revision).padStart(4, '0')}-${String(index + 1).padStart(4, '0')}-${item.relativePath.replace(/[^a-zA-Z0-9._-]+/g, '__')}.bak`;
      if (item.beforeExists) {
        mkdirSync(dirname(join(repoRoot, backupRelative)), { recursive: true });
        writeFileSync(join(repoRoot, backupRelative), item.before, 'utf-8');
      }
      if (item.operation.type === 'delete') rmSync(item.absolutePath);
      else atomicWriteFile(repoRoot, item.relativePath, item.after, { backupRoot: `${SESSION_ROOT}/${session.sessionId}/atomic-backups/r${revision}` });
      records.push({
        revision,
        operationIndex: index + 1,
        type: item.operation.type,
        path: item.relativePath,
        beforeSha256: item.beforeExists ? hash(item.before) : undefined,
        afterSha256: item.afterExists ? hash(item.after) : undefined,
        backupPath: item.beforeExists ? backupRelative : undefined,
        changedLines: changedLinesFor(item),
      });
    });
  } catch (error) {
    for (const record of [...records].reverse()) {
      const absolute = join(repoRoot, record.path);
      if (record.type === 'create') rmSync(absolute, { force: true });
      else if (record.backupPath && existsSync(join(repoRoot, record.backupPath))) atomicWriteFile(repoRoot, record.path, readFileSync(join(repoRoot, record.backupPath), 'utf-8'));
    }
    throw error;
  }

  const absoluteRevisionPatch = revisionPatchPath(repoRoot, session.sessionId, revision);
  mkdirSync(dirname(absoluteRevisionPatch), { recursive: true });
  writeFileSync(absoluteRevisionPatch, revisionPatch, 'utf-8');

  const at = now();
  session.operations.push(...records);
  session.revisions.push({
    revision,
    operations: records,
    changedFiles: records.length,
    changedLines: batchChangedLines,
    patchPath: relative(repoRoot, absoluteRevisionPatch).replace(/\\/g, '/'),
    patchSha256: hash(revisionPatch),
    createdAt: at,
  });
  session.currentRevision = revision;
  session.status = 'dirty';
  session.appliedAt = session.appliedAt ?? at;
  session.verifiedAt = undefined;
  session.checkResults = [];
  session.updatedAt = at;
  if (firstRevision) persistAggregatePatchContent(repoRoot, session, revisionPatch);
  else persistAggregatePatch(repoRoot, session);
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: 'edit_revision_applied',
    summary: `${session.purpose}: revision ${revision}, ${records.length} file(s), ${batchChangedLines} changed line(s)`,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { revision, files: records.map((record) => record.path), revisionPatch: relative(repoRoot, absoluteRevisionPatch).replace(/\\/g, '/'), diffPath: session.diffPath, diffSha256: session.diffSha256 },
  });
  return session;
}

export function createEditSavepoint(repoRoot: string, sessionId: string, nameValue: string): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (['finalized', 'rolled_back'].includes(session.status)) throw new Error(`edit session is closed: ${session.status}`);
  if (session.currentRevision === 0) throw new Error('cannot create a savepoint before the first edit revision');
  const name = nameValue.trim();
  if (!name) throw new Error('savepoint name is required');
  const at = now();
  session.savepoints = [...session.savepoints.filter((savepoint) => savepoint.name !== name), { name, revision: session.currentRevision, createdAt: at }];
  session.updatedAt = at;
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: 'edit_savepoint_created',
    summary: `${session.purpose}: savepoint ${name} at revision ${session.currentRevision}`,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { name, revision: session.currentRevision },
  });
  return session;
}

export function verifyEditSession(repoRoot: string, sessionId: string, input: {
  checkIds?: string[];
  reviewer?: string;
  note?: string;
} = {}): EditSession {
  const request = resolveVerificationRequest(repoRoot, sessionId, input);
  const results = request.checkIds.map((checkId) => {
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
  return persistVerificationResult(repoRoot, request.session, {
    checkIds: request.checkIds,
    reviewer: request.reviewer,
    note: request.note,
    results,
  });
}

export async function verifyEditSessionAsync(repoRoot: string, sessionId: string, input: {
  checkIds?: string[];
  reviewer?: string;
  note?: string;
} = {}, options: {
  onCheckSpawn?: (checkId: string, pid: number) => void;
  subscriberId?: string;
} = {}): Promise<EditSession> {
  const request = resolveVerificationRequest(repoRoot, sessionId, input);
  const results: EditSessionCheckRecord[] = [];
  for (const checkId of request.checkIds) {
    try {
      const result = await runControllerCheckAsync(repoRoot, checkId, {
        onSpawn: (pid) => options.onCheckSpawn?.(checkId, pid),
        subscriberId: options.subscriberId,
      });
      results.push(checkRecord(result));
    } catch (error) {
      results.push({
        checkId,
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        executedAt: now(),
      });
    }
  }
  assertCurrentHashes(repoRoot, request.session);
  return persistVerificationResult(repoRoot, request.session, {
    checkIds: request.checkIds,
    reviewer: request.reviewer,
    note: request.note,
    results,
  });
}

function restoreOperation(repoRoot: string, operation: EditSessionOperationRecord): void {
  const absolute = join(repoRoot, operation.path);
  if (operation.type === 'create') {
    if (existsSync(absolute)) {
      const current = readFileSync(absolute, 'utf-8');
      if (operation.afterSha256 && hash(current) !== operation.afterSha256) throw new Error(`cannot rollback changed file: ${operation.path}`);
      rmSync(absolute);
    }
    return;
  }
  if (!operation.backupPath || !existsSync(join(repoRoot, operation.backupPath))) throw new Error(`missing backup for ${operation.path}`);
  if (operation.type === 'delete') {
    if (existsSync(absolute)) throw new Error(`cannot rollback deletion because path exists: ${operation.path}`);
  } else if (existsSync(absolute)) {
    const current = readFileSync(absolute, 'utf-8');
    if (operation.afterSha256 && hash(current) !== operation.afterSha256) throw new Error(`cannot rollback changed file: ${operation.path}`);
  } else {
    throw new Error(`cannot rollback missing edited file: ${operation.path}`);
  }
  atomicWriteFile(repoRoot, operation.path, readFileSync(join(repoRoot, operation.backupPath), 'utf-8'));
}

export function rollbackEditSession(repoRoot: string, sessionId: string, input: {
  toRevision?: number;
  savepoint?: string;
} = {}): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  if (session.status === 'open' && session.operations.length === 0) {
    const at = now();
    session.status = 'rolled_back';
    session.rolledBackAt = at;
    session.updatedAt = at;
    writeSession(repoRoot, session);
    tryAppendControllerWorklogEvent(repoRoot, {
      category: 'edit',
      action: 'edit_session_rolled_back',
      summary: `${session.purpose}: empty session closed`,
      issueId: session.issueId,
      taskId: session.taskId,
      editSessionId: session.sessionId,
      details: { targetRevision: 0, revertedOperations: 0 },
    });
    return session;
  }
  if (['finalized', 'rolled_back', 'open'].includes(session.status)) {
    throw new Error(`edit session cannot be rolled back from ${session.status}`);
  }
  assertCurrentHashes(repoRoot, session);
  const savepoint = input.savepoint?.trim();
  const savepointRevision = savepoint ? session.savepoints.find((entry) => entry.name === savepoint)?.revision : undefined;
  if (savepoint && savepointRevision === undefined) throw new Error(`savepoint not found: ${savepoint}`);
  const target = savepointRevision ?? (input.toRevision === undefined ? 0 : Math.trunc(input.toRevision));
  if (target < 0 || target >= session.currentRevision) throw new Error(`rollback target must be between 0 and ${session.currentRevision - 1}`);
  const reverted = session.operations.filter((operation) => operation.revision > target).reverse();
  for (const operation of reverted) restoreOperation(repoRoot, operation);

  const at = now();
  session.operations = session.operations.filter((operation) => operation.revision <= target);
  session.revisions = session.revisions.filter((revision) => revision.revision <= target);
  session.savepoints = session.savepoints.filter((entry) => entry.revision <= target);
  session.currentRevision = target;
  session.checkResults = [];
  session.verifiedAt = undefined;
  session.reviewer = undefined;
  session.reviewNote = undefined;
  session.updatedAt = at;
  if (target === 0) {
    session.status = 'rolled_back';
    session.rolledBackAt = at;
  } else {
    session.status = 'dirty';
    session.rolledBackAt = undefined;
  }
  persistAggregatePatch(repoRoot, session);
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: target === 0 ? 'edit_session_rolled_back' : 'edit_session_rolled_back_to_revision',
    summary: target === 0 ? session.purpose : `${session.purpose}: rolled back to revision ${target}`,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: { targetRevision: target, savepoint, revertedOperations: reverted.length },
  });
  return session;
}

export function finalizeEditSession(repoRoot: string, sessionId: string, input: {
  reviewer?: string;
  note?: string;
} = {}): EditSession {
  const session = getEditSession(repoRoot, sessionId);
  const emptyOpenSession = session.status === 'open' && session.operations.length === 0;
  if (!emptyOpenSession && !['dirty', 'checked', 'check_failed'].includes(session.status)) {
    throw new Error(`edit session cannot be finalized from ${session.status}`);
  }
  if (!emptyOpenSession && session.requestedChecks.length > 0) {
    const allRequestedPassed = session.requestedChecks.every((checkId) => session.checkResults.some((result) => result.checkId === checkId && result.ok));
    if (!allRequestedPassed) throw new Error('configured checks must pass before finalization');
  }
  assertCurrentHashes(repoRoot, session);
  session.status = 'finalized';
  session.reviewer = input.reviewer?.trim() || session.reviewer || 'chatgpt-controller';
  session.reviewNote = input.note?.trim() || session.reviewNote;
  session.finalizedAt = now();
  session.updatedAt = session.finalizedAt;
  writeSession(repoRoot, session);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: 'edit',
    action: 'edit_session_finalized',
    summary: `${session.purpose}: ${new Set(session.operations.map((operation) => operation.path)).size} file(s), ${session.currentRevision} revision(s) finalized`,
    actor: session.reviewer,
    issueId: session.issueId,
    taskId: session.taskId,
    editSessionId: session.sessionId,
    details: {
      files: [...new Set(session.operations.map((operation) => operation.path))],
      revisions: session.revisions,
      diffPath: session.diffPath,
      diffSha256: session.diffSha256,
      checkResults: session.checkResults,
      note: session.reviewNote,
    },
  });
  return session;
}
