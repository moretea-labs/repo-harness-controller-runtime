import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import type { EntityMigrationReport, RepositoryRecord } from './types';

function atomicJson(path: string, value: unknown): void {
  const temp = join(dirname(path), `.${path.split(/[\\/]/).at(-1)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

function listFiles(root: string, relativeRoot: string, predicate: (path: string) => boolean): string[] {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return [];
  const result: string[] = [];
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (stat.isFile() && predicate(path)) {
      result.push(path);
    }
  };
  visit(absolute);
  return result;
}

function bindOwnedField(value: Record<string, unknown>, key: string, expected: string, label: string): boolean {
  const current = value[key];
  if (current === undefined || current === null || current === '') {
    value[key] = expected;
    return true;
  }
  if (current !== expected) {
    throw new Error(`${label} is already bound to ${String(current)} and cannot be rebound to ${expected}`);
  }
  return false;
}

function bindIssue(value: Record<string, unknown>, record: RepositoryRecord): boolean {
  let changed = bindOwnedField(value, 'repoId', record.repoId, 'Issue');
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const target = task as Record<string, unknown>;
    changed = bindOwnedField(target, 'repoId', record.repoId, `Task ${String(target.id ?? 'unknown')}`) || changed;
    const verification = target.verification;
    if (verification && typeof verification === 'object') {
      changed = bindOwnedField(verification as Record<string, unknown>, 'repoId', record.repoId, `Verification for ${String(target.id ?? 'unknown')}`) || changed;
    }
  }
  return changed;
}

function inferredCheckoutId(value: Record<string, unknown>, record: RepositoryRecord, label: string): string {
  const existing = typeof value.checkoutId === 'string' ? value.checkoutId.trim() : '';
  if (existing) {
    if (!record.checkouts.some((checkout) => checkout.checkoutId === existing)) {
      throw new Error(`${label} references unknown checkout ${existing}`);
    }
    return existing;
  }
  const repoRoot = typeof value.repoRoot === 'string' ? value.repoRoot : undefined;
  const matched = repoRoot
    ? record.checkouts.find((checkout) => checkout.canonicalRoot === repoRoot || checkout.localRoot === repoRoot)
    : undefined;
  if (matched) return matched.checkoutId;
  if (record.checkouts.length === 1) return record.checkouts[0].checkoutId;
  throw new Error(`${label} has no checkoutId and cannot be inferred across ${record.checkouts.length} checkouts`);
}

function bindRun(value: Record<string, unknown>, record: RepositoryRecord): boolean {
  let changed = bindOwnedField(value, 'repoId', record.repoId, `Run ${String(value.runId ?? 'unknown')}`);
  const checkoutId = inferredCheckoutId(value, record, `Run ${String(value.runId ?? 'unknown')}`);
  if (value.checkoutId !== checkoutId) {
    value.checkoutId = checkoutId;
    changed = true;
  }
  const checkout = record.checkouts.find((candidate) => candidate.checkoutId === checkoutId)!;
  if (value.repoRoot === undefined || value.repoRoot === null || value.repoRoot === '') {
    value.repoRoot = checkout.canonicalRoot;
    changed = true;
  }
  const executionRoot = typeof value.worktree === 'string' && value.worktree
    ? value.worktree
    : typeof value.repoRoot === 'string' && value.repoRoot
      ? value.repoRoot
      : checkout.canonicalRoot;
  if (value.executionRoot === undefined || value.executionRoot === null || value.executionRoot === '') {
    value.executionRoot = executionRoot;
    changed = true;
  }
  if (value.worktreePath === undefined || value.worktreePath === null || value.worktreePath === '') {
    value.worktreePath = executionRoot;
    changed = true;
  }
  return changed;
}

function bindEditSession(value: Record<string, unknown>, record: RepositoryRecord): boolean {
  let changed = bindOwnedField(value, 'repoId', record.repoId, `Edit Session ${String(value.sessionId ?? 'unknown')}`);
  const checkoutId = inferredCheckoutId(value, record, `Edit Session ${String(value.sessionId ?? 'unknown')}`);
  if (value.checkoutId !== checkoutId) {
    value.checkoutId = checkoutId;
    changed = true;
  }
  return changed;
}

function migrateJsonFile(path: string, record: RepositoryRecord, kind: 'issue' | 'run' | 'edit'): boolean {
  const value = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const changed = kind === 'issue'
    ? bindIssue(value, record)
    : kind === 'run'
      ? bindRun(value, record)
      : bindEditSession(value, record);
  if (changed) atomicJson(path, value);
  return changed;
}

function migrateJsonl(path: string, record: RepositoryRecord): boolean {
  const raw = readFileSync(path, 'utf-8');
  let changed = false;
  const output = raw.split(/\r?\n/).map((line: string) => {
    if (!line.trim()) return line;
    const value = JSON.parse(line) as Record<string, unknown>;
    changed = bindOwnedField(value, 'repoId', record.repoId, 'Worklog event') || changed;
    return JSON.stringify(value);
  }).join('\n');
  if (changed) writeFileSync(path, output, 'utf-8');
  return changed;
}

export function bindRepositoryEntities(record: RepositoryRecord): EntityMigrationReport {
  const report: EntityMigrationReport = {
    repoId: record.repoId,
    checkoutId: record.activeCheckoutId,
    scanned: 0,
    updated: 0,
    unresolved: 0,
    files: [],
    errors: [],
  };
  const roots: Array<{ root: string; kind: 'issue' | 'run' | 'edit'; predicate: (path: string) => boolean }> = [
    { root: 'tasks/issues', kind: 'issue', predicate: (path) => path.endsWith('.issue.json') },
    { root: '.ai/harness/ephemeral-issues', kind: 'issue', predicate: (path) => path.endsWith('.issue.json') },
    { root: '.ai/harness/jobs', kind: 'run', predicate: (path) => path.endsWith('/meta.json') || path.endsWith('\\meta.json') },
    { root: '.ai/harness/edit-sessions', kind: 'edit', predicate: (path) => path.endsWith('/session.json') || path.endsWith('\\session.json') },
  ];
  for (const entry of roots) {
    for (const path of listFiles(record.canonicalRoot, entry.root, entry.predicate)) {
      report.scanned += 1;
      try {
        if (migrateJsonFile(path, record, entry.kind)) {
          report.updated += 1;
          report.files.push(relative(record.canonicalRoot, path).replace(/\\/g, '/'));
        }
      } catch (error) {
        report.unresolved += 1;
        report.errors.push({ path: relative(record.canonicalRoot, path), error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  for (const root of ['.ai/harness/controller/worklog.jsonl', '.ai/harness/worklog.jsonl']) {
    const path = join(record.canonicalRoot, root);
    if (!existsSync(path)) continue;
    report.scanned += 1;
    try {
      if (migrateJsonl(path, record)) {
        report.updated += 1;
        report.files.push(root);
      }
    } catch (error) {
      report.unresolved += 1;
      report.errors.push({ path: root, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
