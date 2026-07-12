import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJobEvents, type RuntimeEntityEvent } from '../evidence/event-ledger';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import type { ExecutionJob, ExecutionJobStatus } from '../execution/jobs/types';

export const MAX_CONNECTIVITY_PROBE_EVENTS = 24;

export type ConnectivityTone = 'green' | 'amber' | 'red' | 'blue' | 'gray';
export type ConnectivityOverallStatus = 'stable' | 'degraded' | 'failed' | 'observing';
export type ConnectivityAttributionCategory =
  | 'public_path'
  | 'gateway'
  | 'local_bridge'
  | 'controller'
  | 'connector_or_unknown'
  | 'insufficient_evidence';
export type ConnectivityConfidence = 'high' | 'medium' | 'low';
export type ConnectivityComponentKey =
  | 'local_mcp'
  | 'public_mcp'
  | 'local_bridge'
  | 'controller_daemon'
  | 'scheduler';
export type ConnectivityComponentState = 'ready' | 'degraded' | 'failed' | 'unknown';

export interface ConnectivityComponentObservation {
  component: ConnectivityComponentKey;
  label: string;
  state: ConnectivityComponentState;
  stateLabel: string;
  tone: ConnectivityTone;
  detail: string;
  evidence: string[];
}

export interface ConnectivityAttribution {
  category: ConnectivityAttributionCategory;
  categoryLabel: string;
  overallStatus: ConnectivityOverallStatus;
  overallStatusLabel: string;
  tone: ConnectivityTone;
  confidence: ConnectivityConfidence;
  confidenceLabel: string;
  summary: string;
  evidence: string[];
}

export interface ConnectivityJobTiming {
  jobId: string;
  operation: string;
  status: ExecutionJobStatus;
  statusLabel: string;
  stageLabel: string;
  queuedDelayMs?: number;
  dispatchToStartMs?: number;
  executionDurationMs?: number;
  totalMs?: number;
  evidence: string[];
}

export interface ConnectivityProbeEvent {
  observedAt: string;
  observations: ConnectivityComponentObservation[];
  attribution: ConnectivityAttribution;
  connectorSignals: string[];
  jobTimings: ConnectivityJobTiming[];
}

export interface ConnectivityProbeSummary {
  headline: string;
  status: ConnectivityOverallStatus;
  statusLabel: string;
  tone: ConnectivityTone;
  eventsStored: number;
  latestObservedAt?: string;
  latestAttribution: ConnectivityAttribution;
  attributionCounts: Record<ConnectivityAttributionCategory, number>;
  lastStableAt?: string;
}

export interface ConnectivityObservabilityReport {
  schemaVersion: 1;
  updatedAt: string;
  summary: ConnectivityProbeSummary;
  latestEvent?: ConnectivityProbeEvent;
  events: ConnectivityProbeEvent[];
}

export interface ConnectivityProbeInput {
  controllerHome: string;
  repoId: string;
  observedAt?: string;
  observations: ConnectivityComponentObservation[];
  connectorSignals?: string[];
  jobTimings?: ConnectivityJobTiming[];
}

export interface ConnectivityAttributionInput {
  observations: ConnectivityComponentObservation[];
  connectorSignals?: string[];
}

type JobEventLike = Pick<RuntimeEntityEvent, 'eventType' | 'occurredAt'>;

function connectivityStorePath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'controller', 'connectivity-observability.json');
}

function toneForComponentState(state: ConnectivityComponentState): ConnectivityTone {
  if (state === 'ready') return 'green';
  if (state === 'degraded') return 'amber';
  if (state === 'failed') return 'red';
  return 'gray';
}

function labelForComponentState(state: ConnectivityComponentState): string {
  if (state === 'ready') return '稳定';
  if (state === 'degraded') return '波动';
  if (state === 'failed') return '失败';
  return '未知';
}

function statusLabelForOverallStatus(status: ConnectivityOverallStatus): string {
  if (status === 'stable') return '稳定';
  if (status === 'degraded') return '波动';
  if (status === 'failed') return '失败';
  return '观察中';
}

function toneForOverallStatus(status: ConnectivityOverallStatus): ConnectivityTone {
  if (status === 'stable') return 'green';
  if (status === 'degraded') return 'amber';
  if (status === 'failed') return 'red';
  return 'blue';
}

function labelForCategory(category: ConnectivityAttributionCategory): string {
  switch (category) {
    case 'public_path': return '公网路径';
    case 'gateway': return 'MCP Gateway';
    case 'local_bridge': return 'Local Bridge';
    case 'controller': return 'Controller';
    case 'connector_or_unknown': return '连接器或未知层';
    case 'insufficient_evidence': return '证据不足';
  }
}

function labelForConfidence(confidence: ConnectivityConfidence): string {
  if (confidence === 'high') return '高';
  if (confidence === 'medium') return '中';
  return '低';
}

function statusLabelForJob(status: ExecutionJobStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'waiting_for_dependency': return '等待依赖';
    case 'waiting_for_workspace': return '等待工作区';
    case 'waiting_for_heavy_check': return '等待重检查';
    case 'waiting_for_integration': return '等待集成';
    case 'waiting_for_release_barrier': return '等待发布屏障';
    case 'waiting_for_approval': return '等待审批';
    case 'dispatched': return '已派发';
    case 'running': return '执行中';
    case 'succeeded': return '成功';
    case 'failed': return '失败';
    case 'timed_out': return '超时';
    case 'cancelled': return '已取消';
    case 'orphaned': return '已失联';
    case 'stale': return '已陈旧';
    case 'human_attention_required': return '需人工处理';
  }
}

function stageLabelForJob(status: ExecutionJobStatus): string {
  if (status === 'queued' || status.startsWith('waiting_for_')) return '排队阶段';
  if (status === 'dispatched') return '已派发待启动';
  if (status === 'running') return '执行阶段';
  return '已结束';
}

function msBetween(startAt?: string, endAt?: string): number | undefined {
  if (!startAt || !endAt) return undefined;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function firstEventAt(events: JobEventLike[], eventType: string): string | undefined {
  return events.find((event) => event.eventType === eventType)?.occurredAt;
}

function lastStableAt(events: ConnectivityProbeEvent[]): string | undefined {
  return events.find((event) => event.attribution.overallStatus === 'stable')?.observedAt;
}

function componentMap(observations: ConnectivityComponentObservation[]): Map<ConnectivityComponentKey, ConnectivityComponentObservation> {
  return new Map(observations.map((observation) => [observation.component, observation]));
}

function issueEvidence(observation: ConnectivityComponentObservation | undefined): string[] {
  if (!observation) return [];
  if (observation.evidence.length > 0) return observation.evidence.slice(0, 3);
  return observation.detail ? [`${observation.label}: ${observation.detail}`] : [];
}

function isReady(observation: ConnectivityComponentObservation | undefined): boolean {
  return observation?.state === 'ready';
}

function isIssue(observation: ConnectivityComponentObservation | undefined): boolean {
  return observation?.state === 'degraded' || observation?.state === 'failed';
}

function hasHardFailure(observation: ConnectivityComponentObservation | undefined): boolean {
  return observation?.state === 'failed';
}

function buildAttribution(
  category: ConnectivityAttributionCategory,
  overallStatus: ConnectivityOverallStatus,
  confidence: ConnectivityConfidence,
  summary: string,
  evidence: string[],
): ConnectivityAttribution {
  return {
    category,
    categoryLabel: labelForCategory(category),
    overallStatus,
    overallStatusLabel: statusLabelForOverallStatus(overallStatus),
    tone: toneForOverallStatus(overallStatus),
    confidence,
    confidenceLabel: labelForConfidence(confidence),
    summary,
    evidence: evidence.filter(Boolean).slice(0, 8),
  };
}

export function createConnectivityObservation(
  component: ConnectivityComponentKey,
  label: string,
  state: ConnectivityComponentState,
  detail: string,
  evidence: string[] = [],
): ConnectivityComponentObservation {
  return {
    component,
    label,
    state,
    stateLabel: labelForComponentState(state),
    tone: toneForComponentState(state),
    detail,
    evidence: evidence.filter(Boolean).slice(0, 6),
  };
}

export function classifyConnectivityAttribution(input: ConnectivityAttributionInput): ConnectivityAttribution {
  const observations = componentMap(input.observations);
  const connectorSignals = (input.connectorSignals ?? []).filter(Boolean);
  const localMcp = observations.get('local_mcp');
  const publicMcp = observations.get('public_mcp');
  const localBridge = observations.get('local_bridge');
  const controller = observations.get('controller_daemon');
  const scheduler = observations.get('scheduler');
  const anyIssue = input.observations.some((observation) => isIssue(observation));

  if (isIssue(controller) || isIssue(scheduler)) {
    return buildAttribution(
      'controller',
      hasHardFailure(controller) || hasHardFailure(scheduler) ? 'failed' : 'degraded',
      hasHardFailure(controller) || hasHardFailure(scheduler) ? 'high' : 'medium',
      'Controller daemon 或调度器存在异常，优先定位控制平面与调度心跳。',
      [...issueEvidence(controller), ...issueEvidence(scheduler)],
    );
  }

  if (isIssue(localBridge)) {
    return buildAttribution(
      'local_bridge',
      hasHardFailure(localBridge) ? 'failed' : 'degraded',
      hasHardFailure(localBridge) ? 'high' : 'medium',
      'Local Bridge 本地入口不稳定，优先排查本地控制台进程与监听状态。',
      issueEvidence(localBridge),
    );
  }

  if (isIssue(localMcp)) {
    return buildAttribution(
      'gateway',
      hasHardFailure(localMcp) ? 'failed' : 'degraded',
      hasHardFailure(localMcp) ? 'high' : 'medium',
      '本地 MCP Gateway 响应或暴露面异常，问题更接近本机 MCP 路径。',
      issueEvidence(localMcp),
    );
  }

  if (isIssue(publicMcp) && isReady(localMcp) && isReady(localBridge) && isReady(controller) && isReady(scheduler)) {
    return buildAttribution(
      'public_path',
      hasHardFailure(publicMcp) ? 'failed' : 'degraded',
      'high',
      '本地 MCP 与控制平面正常，但公网 MCP 入口不稳定，优先排查 tunnel / public endpoint。',
      issueEvidence(publicMcp),
    );
  }

  if (connectorSignals.length > 0) {
    return buildAttribution(
      'connector_or_unknown',
      anyIssue ? 'degraded' : 'observing',
      anyIssue ? 'medium' : 'low',
      anyIssue
        ? '观测到连接器层信号，但没有足够证据把问题唯一归到本地入口、Gateway 或公网路径。'
        : '连接器当前有待确认信号，但探测尚未复现明确故障层。',
      connectorSignals.slice(0, 6),
    );
  }

  if (isIssue(publicMcp)) {
    return buildAttribution(
      'public_path',
      hasHardFailure(publicMcp) ? 'failed' : 'degraded',
      'medium',
      '公网 MCP 入口存在异常，但本地上下文不足以完全排除相邻层影响。',
      issueEvidence(publicMcp),
    );
  }

  if (anyIssue) {
    return buildAttribution(
      'connector_or_unknown',
      'degraded',
      'low',
      '探测到连接异常，但现有证据不足以明确唯一故障层。',
      input.observations.flatMap((observation) => issueEvidence(observation)).slice(0, 6),
    );
  }

  return buildAttribution(
    'insufficient_evidence',
    input.observations.some((observation) => observation.state === 'unknown') ? 'observing' : 'stable',
    input.observations.some((observation) => observation.state === 'unknown') ? 'low' : 'medium',
    input.observations.some((observation) => observation.state === 'unknown')
      ? '当前没有足够证据对连接责任层做归因。'
      : '最近一次探测未发现明显连接异常。',
    input.observations
      .filter((observation) => observation.state === 'unknown')
      .flatMap((observation) => issueEvidence(observation))
      .slice(0, 4),
  );
}

export function deriveExecutionJobTimingSnapshot(
  job: Pick<ExecutionJob, 'jobId' | 'status' | 'queuedAt' | 'startedAt' | 'finishedAt' | 'payload'>,
  events: JobEventLike[] = [],
  now = new Date().toISOString(),
): ConnectivityJobTiming {
  const dispatchAt = firstEventAt(events, 'job_dispatched');
  const runningAt = firstEventAt(events, 'job_running');
  const startedAt = job.startedAt ?? runningAt;
  const finishedAt = job.finishedAt;
  const terminalReference = finishedAt ?? (job.status === 'running' || job.status === 'dispatched' || job.status === 'queued' || job.status.startsWith('waiting_for_')
    ? now
    : undefined);
  const queuedDelayMs = msBetween(job.queuedAt, dispatchAt ?? startedAt);
  const dispatchToStartMs = msBetween(dispatchAt, startedAt);
  const executionDurationMs = msBetween(startedAt, terminalReference);
  const totalMs = msBetween(job.queuedAt, terminalReference);
  const evidence: string[] = [];
  if (dispatchAt) evidence.push(`job_dispatched @ ${dispatchAt}`);
  if (startedAt) evidence.push(`started @ ${startedAt}`);
  if (finishedAt) evidence.push(`finished @ ${finishedAt}`);
  if (!dispatchAt) evidence.push('no durable job_dispatched event found');
  return {
    jobId: job.jobId,
    operation: String(job.payload.operation ?? 'unknown'),
    status: job.status,
    statusLabel: statusLabelForJob(job.status),
    stageLabel: stageLabelForJob(job.status),
    queuedDelayMs,
    dispatchToStartMs,
    executionDurationMs,
    totalMs,
    evidence: evidence.slice(0, 5),
  };
}

export function deriveExecutionJobTimingSnapshots(
  controllerHome: string,
  repoId: string,
  jobs: Array<Pick<ExecutionJob, 'jobId' | 'status' | 'queuedAt' | 'startedAt' | 'finishedAt' | 'payload'>>,
  now = new Date().toISOString(),
  limit = 6,
): ConnectivityJobTiming[] {
  return jobs
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map((job) => deriveExecutionJobTimingSnapshot(job, readJobEvents(controllerHome, repoId, job.jobId, 30), now));
}

function emptyCounts(): Record<ConnectivityAttributionCategory, number> {
  return {
    public_path: 0,
    gateway: 0,
    local_bridge: 0,
    controller: 0,
    connector_or_unknown: 0,
    insufficient_evidence: 0,
  };
}

function buildSummary(events: ConnectivityProbeEvent[]): ConnectivityProbeSummary {
  const latest = events[0];
  const counts = emptyCounts();
  for (const event of events) counts[event.attribution.category] += 1;
  const latestAttribution = latest?.attribution ?? buildAttribution(
    'insufficient_evidence',
    'observing',
    'low',
    '尚未记录连接探测。',
    [],
  );
  return {
    headline: latestAttribution.summary,
    status: latestAttribution.overallStatus,
    statusLabel: latestAttribution.overallStatusLabel,
    tone: latestAttribution.tone,
    eventsStored: events.length,
    latestObservedAt: latest?.observedAt,
    latestAttribution,
    attributionCounts: counts,
    lastStableAt: lastStableAt(events),
  };
}

export function readConnectivityObservability(
  controllerHome: string,
  repoId: string,
): ConnectivityObservabilityReport {
  const path = connectivityStorePath(controllerHome, repoId);
  return readJsonFile<ConnectivityObservabilityReport>(path, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    summary: buildSummary([]),
    latestEvent: undefined,
    events: [],
  });
}

export function recordConnectivityProbe(input: ConnectivityProbeInput): ConnectivityObservabilityReport {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const attribution = classifyConnectivityAttribution({
    observations: input.observations,
    connectorSignals: input.connectorSignals,
  });
  const event: ConnectivityProbeEvent = {
    observedAt,
    observations: input.observations,
    attribution,
    connectorSignals: (input.connectorSignals ?? []).filter(Boolean).slice(0, 8),
    jobTimings: (input.jobTimings ?? []).slice(0, 8),
  };
  const current = readConnectivityObservability(input.controllerHome, input.repoId);
  const events = [event, ...current.events].slice(0, MAX_CONNECTIVITY_PROBE_EVENTS);
  const next: ConnectivityObservabilityReport = {
    schemaVersion: 1,
    updatedAt: observedAt,
    summary: buildSummary(events),
    latestEvent: events[0],
    events,
  };
  writeJsonAtomic(connectivityStorePath(input.controllerHome, input.repoId), next);
  return next;
}
