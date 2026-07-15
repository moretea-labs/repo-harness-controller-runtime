import { listActiveAgentJobSnapshots } from '../../cli/agent-jobs/job-manager';
import { getLocalBridgeJobEventsSnapshot, listLocalBridgeJobSnapshots } from '../../cli/local-bridge/job-store';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { listExecutionJobs } from '../execution/jobs/store';
import { collectRuntimePerformanceDiagnostics, type RuntimePerformanceDiagnostics } from '../diagnostics/performance';
import { listSchedules } from '../workflow/schedules/store';

const ACTIVE_AGENT_STATUSES = new Set(['queued', 'starting', 'running']);

export interface WorkflowWatchdogFinding {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
  next: string;
}

export interface WorkflowWatchdogReport {
  repoId: string;
  generatedAt: string;
  status: 'normal' | 'warning' | 'critical';
  findings: WorkflowWatchdogFinding[];
  performance: RuntimePerformanceDiagnostics;
  queues: {
    executionJobs: Record<string, number>;
    localBridgeJobs: Record<string, number>;
    agentJobs: Record<string, number>;
    schedules: { total: number; enabled: number; disabled: number };
  };
  staleWork: Array<{ kind: 'execution' | 'local_bridge' | 'agent'; id: string; status: string; updatedAt?: string; ageMinutes?: number; summary?: string }>;
  recoveryPlan: Array<{ action: string; risk: 'readonly' | 'workspace_write' | 'destructive'; reason: string; command?: string }>;
  next: string[];
}

function now(): string {
  return new Date().toISOString();
}

function countBy<T extends { status?: string }>(items: T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const status = item.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function ageMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.round(ms / 60000);
}

function maxSeverity(findings: WorkflowWatchdogFinding[]): WorkflowWatchdogReport['status'] {
  if (findings.some((finding) => finding.severity === 'critical')) return 'critical';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'normal';
}

export function buildWorkflowWatchdogReport(controllerHome: string, repository: RepositoryRecord, input: { staleMinutes?: unknown; includeProcesses?: unknown } = {}): WorkflowWatchdogReport {
  const staleThreshold = Math.max(10, Math.min(typeof input.staleMinutes === 'number' ? Math.trunc(input.staleMinutes) : 45, 24 * 60));
  const executionJobs = listExecutionJobs(controllerHome, repository.repoId, 200);
  const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 200);
  const agentJobs = listActiveAgentJobSnapshots(repository.canonicalRoot, 200);
  const schedules = listSchedules(controllerHome, repository.repoId);
  const activeJobIds = executionJobs.filter((job) => ['queued', 'running', 'dispatched'].includes(job.status)).map((job) => job.jobId);
  const performance = collectRuntimePerformanceDiagnostics({
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    activeJobIds,
    queueDepth: executionJobs.filter((job) => job.status === 'queued').length,
    runningWorkers: executionJobs.filter((job) => job.status === 'running' || job.status === 'dispatched').length,
    includeProcesses: input.includeProcesses !== false,
    includeTempDirs: true,
    cleanupPreview: true,
  });
  const staleWork = [
    ...executionJobs.filter((job) => ['queued', 'running', 'dispatched'].includes(job.status) && (ageMinutes(job.updatedAt) ?? 0) >= staleThreshold)
      .map((job) => ({ kind: 'execution' as const, id: job.jobId, status: job.status, updatedAt: job.updatedAt, ageMinutes: ageMinutes(job.updatedAt), summary: job.payload.operation })),
    ...localJobs.filter((job) => ['approved', 'running', 'dispatched'].includes(job.status) && (ageMinutes(job.updatedAt) ?? 0) >= staleThreshold)
      .map((job) => ({ kind: 'local_bridge' as const, id: job.jobId, status: job.status, updatedAt: job.updatedAt, ageMinutes: ageMinutes(job.updatedAt), summary: job.action })),
    ...agentJobs.filter((job) => ACTIVE_AGENT_STATUSES.has(job.status) && (ageMinutes(job.progress?.lastActivityAt ?? job.lastHeartbeatAt ?? job.startedAt ?? job.createdAt) ?? 0) >= staleThreshold)
      .map((job) => {
        const updatedAt = job.progress?.lastActivityAt ?? job.lastHeartbeatAt ?? job.startedAt ?? job.createdAt;
        return { kind: 'agent' as const, id: job.runId, status: job.status, updatedAt, ageMinutes: ageMinutes(updatedAt), summary: job.progress?.currentActivity ?? job.taskId ?? job.issueId };
      }),
  ];
  const findings: WorkflowWatchdogFinding[] = [
    ...performance.findings.map((finding) => ({ ...finding, next: finding.severity === 'critical' ? 'Run runtime_cleanup_preview, then decide whether to apply cleanup.' : 'Watch the next monitor tick before mutating runtime state.' })),
    ...(staleWork.length > 0 ? [{ severity: 'warning' as const, code: 'STALE_WORK_ITEMS', message: `${staleWork.length} active work item(s) have not updated for ${staleThreshold}+ minutes.`, evidence: { staleWork }, next: 'Inspect get_job/get_local_job output and cancel or retry only after confirming the work is stale.' }] : []),
    ...(schedules.filter((schedule) => schedule.enabled).length > 20 ? [{ severity: 'warning' as const, code: 'SCHEDULE_VOLUME_HIGH', message: 'Many enabled schedules can repeatedly wake the runtime.', evidence: { enabled: schedules.filter((schedule) => schedule.enabled).length }, next: 'Run schedule_dedupe_report and pause duplicate or obsolete schedules.' }] : []),
  ];
  const recoveryPlan = [
    ...(staleWork.length > 0 ? [{ action: 'inspect_stale_work', risk: 'readonly' as const, reason: 'Read stalled job details before deciding to cancel.' }] : []),
    ...(performance.cleanupPreview && (performance.cleanupPreview.safeToTerminate.length > 0 || performance.cleanupPreview.safeToRemoveTempEntries.length > 0) ? [{ action: 'runtime_cleanup_preview', risk: 'readonly' as const, reason: 'Cleanup candidates exist, but apply requires explicit authorization.' }] : []),
    ...(schedules.length > 0 ? [{ action: 'schedule_dedupe_report', risk: 'readonly' as const, reason: 'Detect duplicate schedules before they generate repeated work.' }] : []),
  ];
  const localEventEvidence = staleWork.filter((entry) => entry.kind === 'local_bridge').slice(0, 3).flatMap((entry) => getLocalBridgeJobEventsSnapshot(repository.canonicalRoot, entry.id).slice(-3));
  if (localEventEvidence.length > 0) {
    findings.push({ severity: 'info', code: 'LOCAL_JOB_EVENT_EVIDENCE', message: 'Recent local bridge events were attached for stale-work inspection.', evidence: { events: localEventEvidence }, next: 'Use event timestamps to decide whether work is genuinely stuck.' });
  }
  return {
    repoId: repository.repoId,
    generatedAt: now(),
    status: maxSeverity(findings),
    findings,
    performance,
    queues: {
      executionJobs: countBy(executionJobs),
      localBridgeJobs: countBy(localJobs),
      agentJobs: countBy(agentJobs),
      schedules: { total: schedules.length, enabled: schedules.filter((schedule) => schedule.enabled).length, disabled: schedules.filter((schedule) => !schedule.enabled).length },
    },
    staleWork,
    recoveryPlan,
    next: [...new Set(findings.map((finding) => finding.next))],
  };
}
