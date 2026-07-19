import { randomUUID } from 'crypto';
import { join } from 'path';
import { readFileSync } from 'fs';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { appendJsonLine } from '../shared/json-files';
import type { ExecutionJob, ExecutionJobEvent } from '../execution/jobs/types';

function ledgerPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
}

function jobEventPath(controllerHome: string, repoId: string, jobId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'events', 'jobs', `${jobId}.jsonl`);
}

export interface RuntimeEntityEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: string;
  repoId: string;
  entityType: 'job' | 'plugin' | 'schedule' | 'occurrence' | 'portfolio' | 'campaign' | 'candidate-finding' | 'release' | 'lease' | 'schedule-decision' | 'assistant-action-proposal' | 'assistant-standing-grant';
  entityId: string;
  correlationId?: string;
  causationId?: string;
  requestId: string;
  revision: number;
  occurredAt: string;
  data?: Record<string, unknown>;
}

export function appendRuntimeEvent(
  controllerHome: string,
  input: Omit<RuntimeEntityEvent, 'schemaVersion' | 'eventId' | 'occurredAt'>,
): RuntimeEntityEvent {
  const event: RuntimeEntityEvent = {
    schemaVersion: 1,
    eventId: `EVT-${Date.now()}-${randomUUID().slice(0, 8)}`,
    occurredAt: new Date().toISOString(),
    ...input,
  };
  appendJsonLine(ledgerPath(controllerHome, input.repoId), event);
  return event;
}

export function appendJobEvent(
  controllerHome: string,
  job: ExecutionJob,
  eventType: string,
  data?: Record<string, unknown>,
): ExecutionJobEvent {
  const event: ExecutionJobEvent = {
    schemaVersion: 1,
    eventId: `EVT-${Date.now()}-${randomUUID().slice(0, 8)}`,
    eventType,
    repoId: job.repoId,
    entityType: 'job',
    entityId: job.jobId,
    correlationId: job.origin.correlationId,
    causationId: job.origin.causationId,
    requestId: job.requestId,
    revision: job.revision,
    occurredAt: new Date().toISOString(),
    data,
  };
  appendJsonLine(ledgerPath(controllerHome, job.repoId), event);
  appendJsonLine(jobEventPath(controllerHome, job.repoId, job.jobId), event);
  return event;
}

export function readJobEvents(controllerHome: string, repoId: string, jobId: string, limit = 200): ExecutionJobEvent[] {
  try {
    const lines = readFileSync(jobEventPath(controllerHome, repoId, jobId), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 1000)));
    return lines.map((line) => JSON.parse(line) as ExecutionJobEvent);
  } catch {
    return [];
  }
}
