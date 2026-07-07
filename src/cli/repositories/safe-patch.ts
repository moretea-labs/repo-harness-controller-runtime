import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import {
  applyEditOperations,
  beginEditSession,
  getEditSession,
  type EditOperation,
  type EditSession,
  type EditSessionPatchError,
} from '../editing/edit-session';
import { getMcpPolicy } from '../mcp/policy';
import type { RepositoryRecord } from './types';

export interface SafePatchFingerprint {
  path: string;
  exists: boolean;
  sha256?: string;
}

export interface SafePatchChunkPlan {
  index: number;
  operationCount: number;
  paths: string[];
  fingerprints: SafePatchFingerprint[];
}

export interface SafePatchPlan {
  operationCount: number;
  chunkSize: number;
  chunks: SafePatchChunkPlan[];
  warnings: string[];
}

export interface SafePatchFailureContext {
  line?: number;
  before?: string;
  focus?: string;
  after?: string;
}

export interface SafePatchPreflightFailure {
  chunkIndex: number;
  operationIndex: number;
  type: EditOperation['type'];
  path: string;
  code:
    | 'PATH_DENIED'
    | 'TARGET_MISSING'
    | 'CREATE_TARGET_EXISTS'
    | 'REPLACEMENT_TEXT_NOT_FOUND'
    | 'ANCHOR_NOT_FOUND'
    | 'NO_CHANGE'
    | 'STALE_FILE_SHA'
    | 'APPLY_FAILED';
  message: string;
  currentSha256?: string;
  expectedSha256?: string;
  context?: SafePatchFailureContext;
}

export interface SafePatchAppliedChunk {
  index: number;
  operationCount: number;
  revision: number;
  paths: string[];
}

export interface SafePatchRecoveredSession {
  reason: string;
  previousSessionId: string;
  newSessionId: string;
}

export interface SafePatchApplyResult {
  status: 'applied' | 'partial' | 'failed';
  session: EditSession;
  createdSession: boolean;
  recoveredSession?: SafePatchRecoveredSession;
  appliedChunks: SafePatchAppliedChunk[];
  failedChunk?: number;
  failures: SafePatchPreflightFailure[];
  plan: SafePatchPlan;
  next: string;
}

const DEFAULT_SAFE_PATCH_CHUNK_SIZE = 40;
const MAX_SAFE_PATCH_CHUNK_SIZE = 100;
const MAX_TEXT_PREVIEW = 240;

type NormalizedOperation = EditOperation & { __originalIndex: number };

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function objectEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
}

function normalizeReplacement(value: unknown): Array<{ oldText: string; newText: string; replaceAll?: boolean }> {
  return objectEntries(value).map((replacement) => ({
    oldText: String(replacement.old_text ?? replacement.oldText ?? ''),
    newText: String(replacement.new_text ?? replacement.newText ?? ''),
    replaceAll: replacement.replace_all === true || replacement.replaceAll === true,
  }));
}

function normalizeOperation(entry: Record<string, unknown>, originalIndex: number): NormalizedOperation {
  const type = String(entry.type ?? '');
  const path = String(entry.path ?? '').trim();
  const expectedSha256 = String(entry.expected_sha256 ?? entry.expectedSha256 ?? '').trim();
  if (!path) throw new Error(`SAFE_PATCH_OPERATION_INVALID: operation ${originalIndex + 1} path is required`);
  if (type === 'create') return { type, path, content: String(entry.content ?? ''), __originalIndex: originalIndex };
  if (type === 'delete') return { type, path, expectedSha256, __originalIndex: originalIndex };
  if (type === 'write') return { type, path, expectedSha256, content: String(entry.content ?? ''), __originalIndex: originalIndex };
  if (type === 'replace') return { type, path, expectedSha256, replacements: normalizeReplacement(entry.replacements), __originalIndex: originalIndex };
  if (type === 'insert_before' || type === 'insert_after') {
    return {
      type,
      path,
      expectedSha256,
      anchor: String(entry.anchor ?? ''),
      content: String(entry.content ?? ''),
      occurrence: typeof entry.occurrence === 'number' ? Math.trunc(entry.occurrence) : undefined,
      __originalIndex: originalIndex,
    };
  }
  if (type === 'prepend' || type === 'append') return { type, path, expectedSha256, content: String(entry.content ?? ''), __originalIndex: originalIndex };
  throw new Error(`SAFE_PATCH_OPERATION_INVALID: operation ${originalIndex + 1} has invalid type: ${type}`);
}

export function normalizeSafePatchOperations(value: unknown): EditOperation[] {
  return objectEntries(value).map((entry, index) => stripInternalIndex(normalizeOperation(entry, index)));
}

function normalizedSafePatchOperations(value: unknown): NormalizedOperation[] {
  return objectEntries(value).map((entry, index) => normalizeOperation(entry, index));
}

function stripInternalIndex(operation: NormalizedOperation): EditOperation {
  const { __originalIndex: _ignored, ...publicOperation } = operation;
  return publicOperation;
}

function chunkSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : DEFAULT_SAFE_PATCH_CHUNK_SIZE;
  if (!Number.isFinite(parsed)) return DEFAULT_SAFE_PATCH_CHUNK_SIZE;
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_SAFE_PATCH_CHUNK_SIZE));
}

function repoRelativePath(repository: RepositoryRecord, rawPath: string): string {
  const root = resolve(repository.canonicalRoot);
  const resolved = resolve(root, rawPath.replace(/\\/g, '/'));
  const rel = relative(root, resolved).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error(`SAFE_PATCH_PATH_DENIED: ${rawPath} escapes the repository`);
  return rel;
}

function fingerprint(repository: RepositoryRecord, rawPath: string): SafePatchFingerprint {
  const path = repoRelativePath(repository, rawPath);
  const absolute = join(repository.canonicalRoot, path);
  if (!existsSync(absolute)) return { path, exists: false };
  return { path, exists: true, sha256: hash(readFileSync(absolute, 'utf-8')) };
}

function currentFile(repository: RepositoryRecord, rawPath: string): { path: string; absolute: string; exists: boolean; content: string; sha256?: string } {
  const path = repoRelativePath(repository, rawPath);
  const absolute = join(repository.canonicalRoot, path);
  if (!existsSync(absolute)) return { path, absolute, exists: false, content: '' };
  const content = readFileSync(absolute, 'utf-8');
  return { path, absolute, exists: true, content, sha256: hash(content) };
}

function buildChunks(operations: NormalizedOperation[], size: number): NormalizedOperation[][] {
  const result: NormalizedOperation[][] = [];
  let current: NormalizedOperation[] = [];
  let currentPaths = new Set<string>();
  for (const operation of operations) {
    const path = operation.path.replace(/\\/g, '/');
    if (current.length >= size || currentPaths.has(path)) {
      result.push(current);
      current = [];
      currentPaths = new Set<string>();
    }
    current.push(operation);
    currentPaths.add(path);
  }
  if (current.length > 0) result.push(current);
  return result;
}

function snippetAround(content: string, needle: string): SafePatchFailureContext {
  const lines = content.split(/\r?\n/);
  const index = needle ? content.indexOf(needle.slice(0, Math.min(needle.length, 80))) : -1;
  let lineIndex = 0;
  if (index >= 0) lineIndex = content.slice(0, index).split(/\r?\n/).length - 1;
  else {
    const trimmed = needle.trim().split(/\r?\n/).find(Boolean)?.slice(0, 40) ?? '';
    const found = trimmed ? lines.findIndex((line) => line.includes(trimmed)) : -1;
    lineIndex = found >= 0 ? found : 0;
  }
  const before = lines.slice(Math.max(0, lineIndex - 3), lineIndex).join('\n').slice(-MAX_TEXT_PREVIEW);
  const focus = (lines[lineIndex] ?? '').slice(0, MAX_TEXT_PREVIEW);
  const after = lines.slice(lineIndex + 1, lineIndex + 4).join('\n').slice(0, MAX_TEXT_PREVIEW);
  return { line: lineIndex + 1, before, focus, after };
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

function applyTextPreview(operation: Exclude<EditOperation, { type: 'create' | 'write' | 'delete' }>, before: string): string {
  if (operation.type === 'replace') {
    let after = before;
    for (const replacement of operation.replacements) {
      if (!replacement.oldText) throw new Error('replacement oldText is empty');
      if (!after.includes(replacement.oldText)) throw new Error('replacement text not found');
      after = replacement.replaceAll ? after.split(replacement.oldText).join(replacement.newText) : after.replace(replacement.oldText, replacement.newText);
    }
    return after;
  }
  if (operation.type === 'prepend') return `${operation.content}${before}`;
  if (operation.type === 'append') return `${before}${operation.content}`;
  const anchored = operation as Extract<EditOperation, { type: 'insert_before' | 'insert_after' }>;
  if (!anchored.anchor) throw new Error('anchor is empty');
  const occurrence = Math.max(1, Math.trunc(anchored.occurrence ?? 1));
  const index = findOccurrence(before, anchored.anchor, occurrence);
  if (index < 0) throw new Error(`anchor occurrence ${occurrence} not found`);
  const insertion = anchored.type === 'insert_before' ? index : index + anchored.anchor.length;
  return `${before.slice(0, insertion)}${anchored.content}${before.slice(insertion)}`;
}

function refreshFingerprint(repository: RepositoryRecord, operation: NormalizedOperation, refresh: boolean): NormalizedOperation {
  if (operation.type === 'create') return operation;
  const current = fingerprint(repository, operation.path);
  if (!current.exists || !current.sha256) return operation;
  if (!refresh && operation.expectedSha256) return operation;
  return { ...operation, expectedSha256: current.sha256 } as NormalizedOperation;
}

function preflightChunk(repository: RepositoryRecord, chunk: NormalizedOperation[], chunkIndex: number, refresh: boolean): { operations: NormalizedOperation[]; failures: SafePatchPreflightFailure[] } {
  const failures: SafePatchPreflightFailure[] = [];
  const refreshed = chunk.map((operation) => refreshFingerprint(repository, operation, refresh));
  for (const operation of refreshed) {
    const current = currentFile(repository, operation.path);
    const base = {
      chunkIndex,
      operationIndex: operation.__originalIndex + 1,
      type: operation.type,
      path: current.path,
    };
    if (operation.type === 'create') {
      if (current.exists) failures.push({ ...base, code: 'CREATE_TARGET_EXISTS', message: `create target already exists: ${current.path}`, currentSha256: current.sha256 });
      continue;
    }
    if (!current.exists) {
      failures.push({ ...base, code: 'TARGET_MISSING', message: `target does not exist: ${current.path}` });
      continue;
    }
    if (operation.expectedSha256 && current.sha256 && operation.expectedSha256 !== current.sha256) {
      failures.push({ ...base, code: 'STALE_FILE_SHA', message: `stale file version for ${current.path}: expected ${operation.expectedSha256}, got ${current.sha256}`, expectedSha256: operation.expectedSha256, currentSha256: current.sha256, context: snippetAround(current.content, '') });
      continue;
    }
    if (operation.type === 'delete') continue;
    const after = operation.type === 'write' ? operation.content : (() => {
      try { return applyTextPreview(operation, current.content); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const needle = operation.type === 'replace' ? operation.replacements.find((replacement) => replacement.oldText && !current.content.includes(replacement.oldText))?.oldText ?? operation.replacements[0]?.oldText ?? '' : 'anchor' in operation ? operation.anchor : '';
        failures.push({ ...base, code: operation.type === 'replace' ? 'REPLACEMENT_TEXT_NOT_FOUND' : 'ANCHOR_NOT_FOUND', message: `${message} in ${current.path}`, currentSha256: current.sha256, context: snippetAround(current.content, needle) });
        return current.content;
      }
    })();
    if (current.content === after) failures.push({ ...base, code: 'NO_CHANGE', message: `edit operation produced no change: ${current.path}`, currentSha256: current.sha256 });
  }
  return { operations: refreshed, failures };
}

export function buildSafePatchPlan(repository: RepositoryRecord, input: { operations: unknown; chunkSize?: unknown }): SafePatchPlan {
  const operations = normalizedSafePatchOperations(input.operations);
  const size = chunkSize(input.chunkSize);
  const grouped = buildChunks(operations, size);
  const warnings: string[] = [];
  if (operations.length === 0) warnings.push('No operations were provided.');
  if (grouped.length > 1) warnings.push(`Operations will be applied in ${grouped.length} deterministic chunk(s) of at most ${size}, with repeated paths isolated into separate revisions.`);
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const operation of operations) {
    const path = repoRelativePath(repository, operation.path);
    if (seen.has(path)) repeated.add(path);
    seen.add(path);
  }
  for (const path of repeated) warnings.push(`Path appears multiple times and will be split across revisions: ${path}`);
  return {
    operationCount: operations.length,
    chunkSize: size,
    chunks: grouped.map((group, index) => {
      const paths = [...new Set(group.map((operation) => repoRelativePath(repository, operation.path)))].sort();
      return { index: index + 1, operationCount: group.length, paths, fingerprints: paths.map((path) => fingerprint(repository, path)) };
    }),
    warnings,
  };
}

function patchErrorFailures(error: unknown, chunkIndex: number): SafePatchPreflightFailure[] {
  const details = (error as EditSessionPatchError | undefined)?.details;
  if (!details?.failures) return [{ chunkIndex, operationIndex: 0, type: 'write', path: '.', code: 'APPLY_FAILED', message: error instanceof Error ? error.message : String(error) }];
  return details.failures.map((failure) => ({
    chunkIndex,
    operationIndex: failure.operationIndex ?? 0,
    type: failure.type ?? 'write',
    path: failure.path ?? '.',
    code: failure.code === 'ANCHOR_NOT_FOUND' ? 'ANCHOR_NOT_FOUND' : failure.code === 'REPLACEMENT_TEXT_NOT_FOUND' ? 'REPLACEMENT_TEXT_NOT_FOUND' : failure.code === 'STALE_FILE_SHA' ? 'STALE_FILE_SHA' : 'APPLY_FAILED',
    message: failure.message,
    currentSha256: failure.currentSha256,
  }));
}

export function applySafePatch(repository: RepositoryRecord, input: {
  sessionId?: unknown;
  purpose?: unknown;
  operations: unknown;
  chunkSize?: unknown;
  expectedRevision?: unknown;
  allowedPaths?: unknown;
  continueOnError?: unknown;
  refreshFingerprints?: unknown;
  recoverStaleSession?: unknown;
}): SafePatchApplyResult {
  const operations = normalizedSafePatchOperations(input.operations);
  if (operations.length === 0) throw new Error('SAFE_PATCH_OPERATIONS_REQUIRED: provide at least one operation');
  const size = chunkSize(input.chunkSize);
  const refresh = input.refreshFingerprints !== false;
  const continueOnError = input.continueOnError === true;
  const policy = getMcpPolicy('controller', { repoRoot: repository.canonicalRoot });
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const allowedPaths = Array.isArray(input.allowedPaths) ? input.allowedPaths.map((item) => String(item).trim()).filter(Boolean) : undefined;
  let session = sessionId
    ? getEditSession(repository.canonicalRoot, sessionId)
    : beginEditSession(repository.canonicalRoot, { purpose: String(input.purpose ?? 'Safe repository patch').trim() || 'Safe repository patch', allowedPaths });
  const createdSession = !sessionId;
  let recoveredSession: SafePatchRecoveredSession | undefined;
  const appliedChunks: SafePatchAppliedChunk[] = [];
  const failures: SafePatchPreflightFailure[] = [];
  const grouped = buildChunks(operations, size);
  const plan = buildSafePatchPlan(repository, { operations, chunkSize: size });
  let expectedRevision = typeof input.expectedRevision === 'number' ? Math.trunc(input.expectedRevision) : session.currentRevision;
  let failedChunk: number | undefined;

  for (const [index, group] of grouped.entries()) {
    const chunkIndex = index + 1;
    const preflight = preflightChunk(repository, group, chunkIndex, refresh);
    if (preflight.failures.length > 0) {
      failures.push(...preflight.failures);
      failedChunk = chunkIndex;
      if (!continueOnError) break;
      continue;
    }
    try {
      session = applyEditOperations(repository.canonicalRoot, policy, session.sessionId, preflight.operations.map(stripInternalIndex), { expectedRevision, maxBatchOperations: MAX_SAFE_PATCH_CHUNK_SIZE });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!sessionId && input.recoverStaleSession !== false && message.includes('EDIT_SESSION_FINGERPRINT_STALE')) {
        const previousSessionId = session.sessionId;
        session = beginEditSession(repository.canonicalRoot, { purpose: `${String(input.purpose ?? 'Safe repository patch').trim() || 'Safe repository patch'} (recovered)`, allowedPaths });
        expectedRevision = session.currentRevision;
        recoveredSession = { reason: 'Previous edit session fingerprints were stale; remaining chunks were moved into a fresh session.', previousSessionId, newSessionId: session.sessionId };
        const retry = preflightChunk(repository, group, chunkIndex, refresh);
        if (retry.failures.length === 0) {
          session = applyEditOperations(repository.canonicalRoot, policy, session.sessionId, retry.operations.map(stripInternalIndex), { expectedRevision, maxBatchOperations: MAX_SAFE_PATCH_CHUNK_SIZE });
        } else {
          failures.push(...retry.failures);
          failedChunk = chunkIndex;
          if (!continueOnError) break;
          continue;
        }
      } else {
        failures.push(...patchErrorFailures(error, chunkIndex));
        failedChunk = chunkIndex;
        if (!continueOnError) break;
        continue;
      }
    }
    expectedRevision = session.currentRevision;
    appliedChunks.push({ index: chunkIndex, operationCount: group.length, revision: session.currentRevision, paths: [...new Set(group.map((operation) => repoRelativePath(repository, operation.path)))].sort() });
  }

  const status: SafePatchApplyResult['status'] = failures.length === 0 ? 'applied' : appliedChunks.length > 0 ? 'partial' : 'failed';
  return {
    status,
    session,
    createdSession,
    ...(recoveredSession ? { recoveredSession } : {}),
    appliedChunks,
    ...(failedChunk ? { failedChunk } : {}),
    failures,
    plan,
    next: status === 'applied'
      ? 'Run repository_git_diff or repository_git_status, then repository_git_commit when ready.'
      : 'Inspect failures[].context, refresh the operation text, and re-run only the failed chunk or remaining operations.',
  };
}
