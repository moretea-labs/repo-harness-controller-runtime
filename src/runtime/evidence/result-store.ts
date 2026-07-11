import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export interface ControllerResultRecord {
  schemaVersion: 1;
  resultId: string;
  resultRef: string;
  repoId: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  kind: 'inspection' | 'command' | 'validation' | 'finalization' | 'generic';
  byteLength: number;
  createdAt: string;
}

function resultRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'results');
  mkdirSync(join(root, 'records'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
  return root;
}

function recordPath(controllerHome: string, repoId: string, resultId: string): string {
  return join(resultRoot(controllerHome, repoId), 'records', `${sanitizeFileComponent(resultId)}.json`);
}

function dataPath(controllerHome: string, repoId: string, resultId: string): string {
  return join(resultRoot(controllerHome, repoId), 'data', `${sanitizeFileComponent(resultId)}.json`);
}

function parseRef(resultRef: string): { repoId: string; resultId: string } {
  const match = /^result:\/\/([^/]+)\/([^/]+)$/.exec(resultRef.trim());
  if (!match) throw new Error('RESULT_REF_INVALID: expected result://<repoId>/<resultId>');
  return { repoId: match[1]!, resultId: match[2]! };
}

export function writeControllerResult(input: {
  controllerHome: string;
  repoId: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  kind: ControllerResultRecord['kind'];
  value: unknown;
}): ControllerResultRecord {
  const resultId = `res_${randomUUID().replace(/-/g, '')}`;
  const resultRef = `result://${input.repoId}/${resultId}`;
  const path = dataPath(input.controllerHome, input.repoId, resultId);
  writeJsonAtomic(path, input.value);
  const record: ControllerResultRecord = {
    schemaVersion: 1,
    resultId,
    resultRef,
    repoId: input.repoId,
    sessionId: input.sessionId,
    principalId: input.principalId,
    ...(input.workId ? { workId: input.workId } : {}),
    kind: input.kind,
    byteLength: statSync(path).size,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(recordPath(input.controllerHome, input.repoId, resultId), record);
  return record;
}

function authorizeRecord(record: ControllerResultRecord, sessionId: string, principalId: string, workId?: string): void {
  if (record.sessionId !== sessionId || record.principalId !== principalId) throw new Error('RESULT_ACCESS_DENIED: result belongs to another session or principal');
  if (workId && record.workId && record.workId !== workId) throw new Error('RESULT_ACCESS_DENIED: result belongs to another work handle');
}

export function readControllerResult(input: {
  controllerHome: string;
  resultRef: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  cursor?: number;
  limit?: number;
}): { record: ControllerResultRecord; items: unknown; cursor: number; nextCursor?: number; truncated: boolean } {
  const parsed = parseRef(input.resultRef);
  const record = readJsonFile<ControllerResultRecord>(recordPath(input.controllerHome, parsed.repoId, parsed.resultId));
  if (record.resultRef !== input.resultRef || record.repoId !== parsed.repoId) throw new Error('RESULT_IDENTITY_MISMATCH');
  authorizeRecord(record, input.sessionId, input.principalId, input.workId);
  const value = readJsonFile<unknown>(dataPath(input.controllerHome, parsed.repoId, parsed.resultId));
  const cursor = Math.max(0, Math.trunc(input.cursor ?? 0));
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  if (Array.isArray(value)) {
    const items = value.slice(cursor, cursor + limit);
    return { record, items, cursor, ...(cursor + items.length < value.length ? { nextCursor: cursor + items.length } : {}), truncated: cursor + items.length < value.length };
  }
  if (typeof value === 'string') {
    const items = value.slice(cursor, cursor + limit * 4_096);
    return { record, items, cursor, ...(cursor + items.length < value.length ? { nextCursor: cursor + items.length } : {}), truncated: cursor + items.length < value.length };
  }
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)) {
    const source = (value as Record<string, unknown>).items as unknown[];
    const items = source.slice(cursor, cursor + limit);
    return { record, items, cursor, ...(cursor + items.length < source.length ? { nextCursor: cursor + items.length } : {}), truncated: cursor + items.length < source.length };
  }
  return { record, items: value, cursor, truncated: false };
}

export function searchControllerResult(input: {
  controllerHome: string;
  resultRef: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  query: string;
  limit?: number;
}): { record: ControllerResultRecord; matches: Array<{ line: number; text: string }>; truncated: boolean } {
  const parsed = parseRef(input.resultRef);
  const record = readJsonFile<ControllerResultRecord>(recordPath(input.controllerHome, parsed.repoId, parsed.resultId));
  if (record.resultRef !== input.resultRef || record.repoId !== parsed.repoId) throw new Error('RESULT_IDENTITY_MISMATCH');
  authorizeRecord(record, input.sessionId, input.principalId, input.workId);
  const value = readJsonFile<unknown>(dataPath(input.controllerHome, parsed.repoId, parsed.resultId));
  const query = input.query.trim().toLowerCase();
  if (!query) throw new Error('RESULT_QUERY_REQUIRED');
  const lines = JSON.stringify(value, null, 2).split(/\r?\n/);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const matches = lines.flatMap((text, index) => text.toLowerCase().includes(query) ? [{ line: index + 1, text: text.slice(0, 2_000) }] : []).slice(0, limit);
  return { record, matches, truncated: lines.filter((text) => text.toLowerCase().includes(query)).length > matches.length };
}
