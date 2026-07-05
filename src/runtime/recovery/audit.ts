import { createHash } from 'crypto';
import type { RecoveryActionDescriptor, RecoveryAuditRecord, RecoveryEvidence } from './types';

export interface BuildRecoveryAuditRecordInput {
  actor: string;
  action: RecoveryActionDescriptor;
  result: RecoveryAuditRecord['result'];
  reason: string;
  affectedPaths?: string[];
  evidence?: RecoveryEvidence[];
  at?: string;
}

export function buildRecoveryAuditRecord(input: BuildRecoveryAuditRecordInput): RecoveryAuditRecord {
  const at = input.at ?? new Date().toISOString();
  const identity = createHash('sha256')
    .update(JSON.stringify({ at, actor: input.actor, actionId: input.action.id, result: input.result, reason: input.reason }))
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: 1,
    id: `REC-${identity}`,
    at,
    actor: input.actor,
    actionId: input.action.id,
    risk: input.action.risk,
    confirmation: input.action.confirmation,
    result: input.result,
    reason: input.reason,
    affectedPaths: input.affectedPaths ?? [],
    evidence: input.evidence ?? [],
  };
}

export function assertRecoveryAuthorized(action: RecoveryActionDescriptor, authorization?: string): void {
  if (action.confirmation === 'none') return;
  if (authorization !== action.id) throw new Error(`RECOVERY_AUTHORIZATION_REQUIRED: ${action.id} requires ${action.confirmation}`);
}
