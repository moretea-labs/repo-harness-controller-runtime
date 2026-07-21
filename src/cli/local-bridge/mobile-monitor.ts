import { statfsSync } from 'fs';
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from 'os';
import { readControllerDaemonStatus } from '../../runtime/control-plane/daemon-client';
import { listExecutionJobs } from '../../runtime/execution/jobs/store';
import type { ExecutionJob } from '../../runtime/execution/jobs/types';
import { readRepositoryProjectionSnapshot } from '../../runtime/projections/materialized-view';

export type MobileMonitorState = 'healthy' | 'degraded' | 'attention' | 'offline';

export interface MobileMonitorSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  revision: number;
  state: MobileMonitorState;
  statusLabel: string;
  statusDetail: string;
  repository: { repoId: string; name: string };
  controller: {
    daemon: string;
    scheduler: string;
    workers: string;
    projection: string;
    connector: string;
    projectionStale: boolean;
  };
  execution: {
    queueDepth: number;
    runningWorkers: number;
    activeLeases: number;
    activeJobs: MobileMonitorJob[];
  };
  attention: MobileMonitorAttention[];
  recent: MobileMonitorEvent[];
  host: {
    name: string;
    loadPerCpu: number;
    memoryUsedPercent: number;
    diskUsedPercent?: number;
    uptimeSeconds: number;
  };
  pollAfterMs: number;
}

export interface MobileMonitorJob {
  jobId: string;
  operation: string;
  type: string;
  status: string;
  priority: string;
  startedAt?: string;
  updatedAt: string;
  heartbeatAt?: string;
  attempt: number;
  maxAttempts: number;
}

export interface MobileMonitorAttention {
  id: string;
  severity: 'warning' | 'critical';
  title: string;
  detail?: string;
  occurredAt?: string;
}

export interface MobileMonitorEvent {
  id: string;
  tone: 'success' | 'warning' | 'error' | 'info';
  title: string;
  occurredAt: string;
}

const ACTIVE_STATUSES = new Set([
  'queued', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check',
  'waiting_for_integration', 'waiting_for_release_barrier', 'waiting_for_approval',
  'running', 'dispatched', 'stale', 'human_attention_required',
]);

function operationLabel(job: ExecutionJob): string {
  const operation = typeof job.payload.operation === 'string' ? job.payload.operation.trim() : '';
  return operation || job.type;
}

function eventTone(status: string): MobileMonitorEvent['tone'] {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'timed_out' || status === 'orphaned') return 'error';
  if (status === 'cancelled' || status === 'stale' || status === 'human_attention_required') return 'warning';
  return 'info';
}

function statusTitle(job: ExecutionJob): string {
  const labels: Record<string, string> = {
    succeeded: '已完成', failed: '执行失败', timed_out: '执行超时', cancelled: '已取消',
    orphaned: '执行器失联', stale: '心跳过期', human_attention_required: '需要人工处理',
  };
  return `${operationLabel(job)} · ${labels[job.status] ?? job.status}`;
}

function boundedMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function diskUsedPercent(repoRoot: string): number | undefined {
  try {
    const stats = statfsSync(repoRoot);
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    if (!Number.isFinite(total) || total <= 0) return undefined;
    return Math.round(((total - available) / total) * 100);
  } catch {
    return undefined;
  }
}

export function buildMobileMonitorSnapshot(input: {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  repositoryName: string;
}): MobileMonitorSnapshot {
  const generatedAt = new Date().toISOString();
  const daemon = readControllerDaemonStatus(input.controllerHome);
  const projectionSnapshot = readRepositoryProjectionSnapshot(input.controllerHome, input.repoId);
  const projection = projectionSnapshot.projection;
  const jobs = listExecutionJobs(input.controllerHome, input.repoId, 80);
  const activeJobs = jobs
    .filter((job) => ACTIVE_STATUSES.has(job.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 6);

  const attention: MobileMonitorAttention[] = projection.currentAttention.slice(0, 6).map((item) => ({
    id: item.jobId,
    severity: item.status === 'orphaned' || item.status === 'human_attention_required' ? 'critical' : 'warning',
    title: item.status === 'orphaned' ? '执行器失联' : item.status === 'stale' ? '任务心跳过期' : '需要人工处理',
    detail: boundedMessage(item.message),
    occurredAt: jobs.find((job) => job.jobId === item.jobId)?.updatedAt,
  }));

  const daemonOnline = daemon.status === 'ready' || daemon.status === 'starting';
  const degraded = daemon.degraded === true || projectionSnapshot.stale || (projection.plugins?.degraded ?? 0) > 0 || (projection.plugins?.error ?? 0) > 0;
  const state: MobileMonitorState = !daemonOnline ? 'offline' : attention.length > 0 ? 'attention' : degraded ? 'degraded' : 'healthy';
  const statusLabel = state === 'healthy' ? '系统正常' : state === 'degraded' ? '系统降级' : state === 'attention' ? '需要处理' : '连接离线';
  const statusDetail = state === 'healthy'
    ? activeJobs.length > 0 ? `${activeJobs.length} 个任务正在活动` : '当前没有活动任务'
    : state === 'degraded'
      ? projectionSnapshot.stale ? 'Projection 数据正在刷新' : daemon.error ?? '部分组件处于降级状态'
      : state === 'attention'
        ? `${attention.length} 项需要检查`
        : daemon.error ?? `Controller ${daemon.status}`;

  const memoryTotal = totalmem();
  const memoryUsedPercent = memoryTotal > 0 ? Math.round(((memoryTotal - freemem()) / memoryTotal) * 100) : 0;
  const cpuCount = Math.max(1, cpus().length);

  return {
    schemaVersion: 1,
    generatedAt,
    revision: projection.revision,
    state,
    statusLabel,
    statusDetail,
    repository: { repoId: input.repoId, name: input.repositoryName },
    controller: {
      daemon: daemon.status,
      scheduler: daemon.degraded ? 'degraded' : daemonOnline ? 'healthy' : 'offline',
      workers: daemonOnline ? 'healthy' : 'offline',
      projection: projectionSnapshot.stale ? 'stale' : projectionSnapshot.persisted ? 'healthy' : 'memory',
      connector: daemon.restartRequired ? 'reconnect_required' : 'connected',
      projectionStale: projectionSnapshot.stale,
    },
    execution: {
      queueDepth: projection.queueDepth,
      runningWorkers: projection.runningWorkers,
      activeLeases: projection.activeLeases,
      activeJobs: activeJobs.map((job) => ({
        jobId: job.jobId,
        operation: operationLabel(job),
        type: job.type,
        status: job.status,
        priority: job.priority,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        heartbeatAt: job.heartbeatAt,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
      })),
    },
    attention,
    recent: jobs
      .filter((job) => Boolean(job.finishedAt))
      .sort((left, right) => (right.finishedAt ?? right.updatedAt).localeCompare(left.finishedAt ?? left.updatedAt))
      .slice(0, 8)
      .map((job) => ({
        id: job.jobId,
        tone: eventTone(job.status),
        title: statusTitle(job),
        occurredAt: job.finishedAt ?? job.updatedAt,
      })),
    host: {
      name: hostname(),
      loadPerCpu: Number((loadavg()[0] / cpuCount).toFixed(2)),
      memoryUsedPercent,
      diskUsedPercent: diskUsedPercent(input.repoRoot),
      uptimeSeconds: Math.round(uptime()),
    },
    pollAfterMs: activeJobs.length > 0 || attention.length > 0 ? 5_000 : 15_000,
  };
}
