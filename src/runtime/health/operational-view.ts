import type { ExecutionJob } from '../execution/jobs/types';
import type { HandoffItem, HandoffStatus } from '../control-plane/facade/types';
import { isTerminalHandoffStatus } from '../control-plane/facade/types';
import type { RuntimeHealthEvaluation } from './evaluator';

export type AttentionDispositionStatus = Extract<HandoffStatus, 'pending' | 'acknowledged' | 'resolved' | 'dismissed'>;

export interface AttentionDisposition {
  attentionId: string;
  sourceJobId?: string;
  status: AttentionDispositionStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolver?: string;
  resolution?: string;
}

export interface ActiveBlocker {
  code: string;
  message: string;
  component: string;
  details?: Record<string, unknown>;
}

export interface AttentionItem {
  attentionId: string;
  sourceJobId?: string;
  title: string;
  severity: 'info' | 'needs_review' | 'blocked' | 'failed';
  summary: string;
  disposition: AttentionDisposition;
}

export interface HistoricalIncident {
  incidentId: string;
  sourceJobId?: string;
  sourceHandoffId?: string;
  kind: 'execution_job' | 'handoff';
  status: string;
  summary: string;
  occurredAt: string;
  resolvedAt?: string;
  disposition?: AttentionDisposition;
}

export interface RuntimeOperationalView {
  health: {
    state: RuntimeHealthEvaluation['state'];
    activeBlockers: ActiveBlocker[];
  };
  attention: {
    pending: AttentionItem[];
  };
  history: {
    recentIncidents: HistoricalIncident[];
    truncated: boolean;
  };
}

export interface RuntimeOperationalViewInput {
  health: RuntimeHealthEvaluation;
  handoffs?: readonly HandoffItem[];
  jobs?: readonly ExecutionJob[];
  historyLimit?: number;
}

const ATTENTION_JOB_STATUSES = new Set<ExecutionJob['status']>([
  'orphaned',
  'human_attention_required',
  'stale',
]);

const INCIDENT_JOB_STATUSES = new Set<ExecutionJob['status']>([
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
  'stale',
  'human_attention_required',
]);

function jobDisposition(job: ExecutionJob, status: AttentionDispositionStatus): AttentionDisposition {
  return {
    attentionId: `job:${job.jobId}`,
    sourceJobId: job.jobId,
    status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(status === 'resolved' && job.finishedAt ? { resolvedAt: job.finishedAt } : {}),
    ...(status === 'resolved' && job.error?.message ? { resolution: job.error.message } : {}),
  };
}

function handoffDisposition(item: HandoffItem): AttentionDisposition {
  const status: AttentionDispositionStatus = item.status === 'pending'
    ? 'pending'
    : item.status === 'resolved'
      ? 'resolved'
      : item.status === 'dismissed' || isTerminalHandoffStatus(item.status)
        ? 'dismissed'
        : 'acknowledged';
  return {
    attentionId: item.id,
    ...(item.currentState.workId ? { sourceJobId: item.currentState.workId } : {}),
    status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(isTerminalHandoffStatus(item.status) && item.updatedAt ? { resolvedAt: item.updatedAt } : {}),
    ...(item.resolver ? { resolver: item.resolver } : {}),
    ...(item.decision ? { resolution: item.decision } : {}),
  };
}

function handoffSeverity(item: HandoffItem): AttentionItem['severity'] {
  if (item.severity === 'failed') return 'failed';
  if (item.severity === 'blocked') return 'blocked';
  return item.severity === 'needs_review' ? 'needs_review' : 'info';
}

function compareNewest(left: { occurredAt: string }, right: { occurredAt: string }): number {
  return right.occurredAt.localeCompare(left.occurredAt);
}

export function buildRuntimeOperationalView(input: RuntimeOperationalViewInput): RuntimeOperationalView {
  const historyLimit = Math.max(1, Math.min(Math.trunc(input.historyLimit ?? 20), 100));
  const jobs = input.jobs ?? [];
  const handoffs = input.handoffs ?? [];

  const pendingJobs: AttentionItem[] = jobs
    .filter((job) => ATTENTION_JOB_STATUSES.has(job.status) && !job.finishedAt)
    .map((job) => ({
      attentionId: `job:${job.jobId}`,
      sourceJobId: job.jobId,
      title: `Execution Job ${job.jobId}`,
      severity: job.status === 'human_attention_required' ? 'needs_review' : 'failed',
      summary: job.error?.message ?? `Execution Job is ${job.status}.`,
      disposition: jobDisposition(job, 'pending'),
    }));

  const pendingHandoffs: AttentionItem[] = handoffs
    .filter((item) => !isTerminalHandoffStatus(item.status))
    .map((item) => ({
      attentionId: item.id,
      ...(item.currentState.workId ? { sourceJobId: item.currentState.workId } : {}),
      title: item.title,
      severity: handoffSeverity(item),
      summary: item.summary,
      disposition: handoffDisposition(item),
    }));

  const incidents: HistoricalIncident[] = [
    ...jobs
      .filter((job) => INCIDENT_JOB_STATUSES.has(job.status) && Boolean(job.finishedAt))
      .map((job) => ({
        incidentId: `job:${job.jobId}`,
        sourceJobId: job.jobId,
        kind: 'execution_job' as const,
        status: job.status,
        summary: job.error?.message ?? `Execution Job finished with status ${job.status}.`,
        occurredAt: job.finishedAt ?? job.updatedAt,
        ...(job.finishedAt ? { resolvedAt: job.finishedAt } : {}),
        ...(ATTENTION_JOB_STATUSES.has(job.status) ? { disposition: jobDisposition(job, 'resolved') } : {}),
      })),
    ...handoffs
      .filter((item) => isTerminalHandoffStatus(item.status))
      .map((item) => ({
        incidentId: `handoff:${item.id}`,
        sourceHandoffId: item.id,
        ...(item.currentState.workId ? { sourceJobId: item.currentState.workId } : {}),
        kind: 'handoff' as const,
        status: item.status,
        summary: item.summary,
        occurredAt: item.updatedAt,
        ...(item.status === 'resolved' ? { resolvedAt: item.updatedAt } : {}),
        disposition: handoffDisposition(item),
      })),
  ].sort(compareNewest);

  return {
    health: {
      state: input.health.state,
      activeBlockers: input.health.activeBlockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        component: blocker.component,
        ...(blocker.details ? { details: blocker.details } : {}),
      })),
    },
    attention: {
      pending: [...pendingHandoffs, ...pendingJobs],
    },
    history: {
      recentIncidents: incidents.slice(0, historyLimit),
      truncated: incidents.length > historyLimit,
    },
  };
}
