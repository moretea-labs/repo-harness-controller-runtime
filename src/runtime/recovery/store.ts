import { mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import type { RecoveryAuditRecord } from './types';

function recoveryRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'recovery');
  mkdirSync(root, { recursive: true });
  return root;
}

function auditRoot(controllerHome: string, repoId: string): string {
  const root = join(recoveryRoot(controllerHome, repoId), 'audit');
  mkdirSync(root, { recursive: true });
  return root;
}

export function writeRecoveryAuditRecord(controllerHome: string, repoId: string, record: RecoveryAuditRecord): RecoveryAuditRecord {
  writeJsonAtomic(join(auditRoot(controllerHome, repoId), `${sanitizeFileComponent(record.id)}.json`), record);
  return record;
}

export function listRecoveryAuditRecords(controllerHome: string, repoId: string, limit = 20): RecoveryAuditRecord[] {
  const root = auditRoot(controllerHome, repoId);
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(Math.trunc(limit), 100)))
    .flatMap((name) => {
      try { return [readJsonFile<RecoveryAuditRecord>(join(root, name))]; }
      catch { return []; }
    });
}
