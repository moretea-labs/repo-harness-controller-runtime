import type { ExecutionJob, ExecutionJobStatus } from '../../execution/jobs/types';
import { TERMINAL_JOB_STATUSES } from '../../execution/jobs/types';
import {
  childReferenceFromJob,
  hasDurableChildReference,
  isAgentDelegationOperation,
  type ExecutionChildReference,
} from '../../execution/jobs/child-reference';
import type { SuggestedNextAction } from './types';

export type UserFacingErrorClass =
  | 'controller_unavailable'
  | 'connector_stale'
  | 'infrastructure_failure'
  | 'acceptance_failure'
  | 'invalid_check_id'
  | 'approval_required'
  | 'handoff_required'
  | 'timeout'
  | 'policy_denied'
  | 'not_found'
  | 'unknown_failure';

export type UserFacingPhase =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'blocked'
  | 'needs_attention'
  | 'cancelled';

export interface OperationDigest {
  schemaVersion: 1;
  phase: UserFacingPhase;
  statusLabel: string;
  summary: string;
  terminal: boolean;
  /** @deprecated Ambiguous legacy field. Prefer requestAccepted/resultAccepted. */
  accepted?: boolean;
  requestAccepted?: boolean;
  resultAccepted?: boolean | null;
  operation?: string;
  workId?: string;
  jobId?: string;
  requestId?: string;
  changedFiles?: string[];
  evidenceRefs?: Array<{ title: string; summary?: string }>;
  errorClass?: UserFacingErrorClass;
  errorMessage?: string;
  suggestedNextActions: SuggestedNextAction[];
  rawAvailable: false;
  /** Present when the parent Job only accepted an Agent Run and is not the authority for run progress. */
  childReference?: ExecutionChildReference;
  childRunStatus?: string;
  childLocalJobStatus?: string;
  delegationAccepted?: boolean;
}

function bound(text: string, max = 400): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function classifyUserFacingError(input: {
  code?: string;
  message?: string;
  status?: string;
  infrastructure?: boolean;
  acceptance?: boolean;
}): UserFacingErrorClass {
  const code = (input.code ?? '').toLowerCase();
  const message = (input.message ?? '').toLowerCase();
  const blob = `${code} ${message} ${input.status ?? ''}`;

  if (input.infrastructure && !input.acceptance) return 'infrastructure_failure';
  if (input.acceptance || blob.includes('acceptance') || blob.includes('valid_fail') || blob.includes('check failed') || blob.includes('] failed') || blob.includes('expected ') && blob.includes(' got ')) {
    return 'acceptance_failure';
  }
  if (blob.includes('invalid_check_id') || blob.includes('check not found') || blob.includes('check_id')) {
    if (blob.includes('invalid') || blob.includes('not found') || blob.includes('not registered')) return 'invalid_check_id';
  }
  if (
    blob.includes('approval_required')
    || blob.includes('approval required')
    || blob.includes('requires approval')
    || blob.includes('waiting_for_approval')
    || blob.includes('awaiting approval')
    || blob.includes('authorization required')
    || blob.includes('confirm authorization')
  ) return 'approval_required';
  if (blob.includes('handoff') || blob.includes('needs_review') || blob.includes('human_attention')) return 'handoff_required';
  if (blob.includes('timed_out') || blob.includes('timed out') || blob.includes('timeout')) return 'timeout';
  if (blob.includes('stale connector') || blob.includes('tool surface') || blob.includes('fingerprint') || blob.includes('reconnect')) {
    return 'connector_stale';
  }
  if (
    blob.includes('daemon')
    || blob.includes('controller unavailable')
    || blob.includes('not ready')
    || blob.includes('econnrefused')
  ) {
    return 'controller_unavailable';
  }
  if (blob.includes('denied') || blob.includes('policy') || blob.includes('forbidden') || blob.includes('not allowed')) {
    return 'policy_denied';
  }
  if (
    blob.includes('infrastructure')
    || blob.includes('runtime_storage')
    || blob.includes('worker')
    || blob.includes('spawn')
    || blob.includes('enoent')
  ) {
    return 'infrastructure_failure';
  }
  if (blob.includes('not found') || blob.includes('not_found')) return 'not_found';
  if (!code && !message.trim()) return 'unknown_failure';
  return 'unknown_failure';
}

export function phaseFromJobStatus(status: ExecutionJobStatus | string): UserFacingPhase {
  switch (status) {
    case 'queued':
    case 'dispatched':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting_for_dependency':
    case 'waiting_for_workspace':
    case 'waiting_for_heavy_check':
    case 'waiting_for_integration':
    case 'waiting_for_release_barrier':
    case 'waiting_for_approval':
      return 'waiting';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    case 'human_attention_required':
      return 'needs_attention';
    case 'cancelled':
    case 'orphaned':
    case 'stale':
      return 'cancelled';
    default:
      return 'running';
  }
}

export function statusLabelForPhase(phase: UserFacingPhase): string {
  switch (phase) {
    case 'queued': return '已排队';
    case 'running': return '执行中';
    case 'waiting': return '等待中';
    case 'succeeded': return '已完成';
    case 'failed': return '失败';
    case 'timed_out': return '超时';
    case 'blocked': return '已阻塞';
    case 'needs_attention': return '需要你处理';
    case 'cancelled': return '已取消';
    default: return '处理中';
  }
}

function defaultNextActions(phase: UserFacingPhase, jobId?: string, errorClass?: UserFacingErrorClass): SuggestedNextAction[] {
  if (phase === 'queued' || phase === 'running' || phase === 'waiting') {
    return [{
      label: '查看任务状态',
      tool: 'rh_work',
      operation: 'continue',
      payload: jobId ? { work_id: jobId } : undefined,
      risk: 'readonly',
      confidence: 'high',
      reason: '轮询或继续查看当前执行状态。',
    }];
  }
  if (phase === 'failed' || phase === 'timed_out') {
    if (errorClass === 'acceptance_failure' || errorClass === 'invalid_check_id' || errorClass === 'policy_denied') {
      return [{
        label: errorClass === 'policy_denied' ? '检查策略限制' : '修复代码或检查契约',
        tool: 'rh_context',
        operation: 'get',
        payload: jobId ? { work_id: jobId } : undefined,
        risk: 'readonly',
        confidence: 'high',
      }];
    }
    return [{
      label: '诊断环境（dry-run）',
      tool: 'rh_work',
      operation: 'repair',
      payload: { repair_operation: 'diagnose', dry_run: true },
      risk: 'readonly',
      confidence: 'high',
    }];
  }
  if (phase === 'needs_attention') {
    return [{
      label: '查看待决定事项',
      tool: 'rh_inbox',
      operation: 'list',
      risk: 'readonly',
      confidence: 'high',
    }];
  }
  return [{
    label: '查看控制器状态',
    tool: 'rh_status',
    operation: 'get',
    risk: 'readonly',
    confidence: 'medium',
  }];
}

function extractChangedFiles(job: ExecutionJob): string[] {
  const result = job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : {};
  const candidates: string[] = [];
  const pushList = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) candidates.push(entry.trim());
      else if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
        candidates.push(String((entry as { path: string }).path));
      }
    }
  };
  pushList(result.changedFiles);
  pushList(result.changed_files);
  pushList(result.paths);
  if (result.session && typeof result.session === 'object') {
    const session = result.session as Record<string, unknown>;
    pushList(session.changedFiles);
    if (Array.isArray(session.operations)) {
      for (const op of session.operations) {
        if (op && typeof op === 'object' && typeof (op as { path?: unknown }).path === 'string') {
          candidates.push(String((op as { path: string }).path));
        }
      }
    }
  }
  if (result.appliedChunks && Array.isArray(result.appliedChunks)) {
    for (const chunk of result.appliedChunks) {
      if (chunk && typeof chunk === 'object') pushList((chunk as { paths?: unknown }).paths);
    }
  }
  return [...new Set(candidates)].slice(0, 30);
}

function readableErrorMessage(job: ExecutionJob): string | undefined {
  const code = job.error?.code?.trim();
  const message = job.error?.message?.trim();
  // Never embed a full JSON response dump into errorMessage.
  if (message) {
    const trimmed = message.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 240) {
      return bound(`${code || 'STRUCTURED_ERROR'}: see artifactRefs / get_artifact (message ${trimmed.length} chars suppressed)`);
    }
    return bound(message);
  }
  if (code) return bound(code);
  if (job.outcome?.infrastructureError?.message) return bound(job.outcome.infrastructureError.message);
  if (job.status === 'failed') return '任务失败，但未提供详细错误信息。请查看证据或运行诊断。';
  if (job.status === 'timed_out') return '任务超时。';
  if (job.status === 'waiting_for_approval') {
    const approval = job.result?.authorization && typeof job.result.authorization === 'object'
      ? job.result.authorization as Record<string, unknown>
      : undefined;
    return typeof approval?.humanSummary === 'string'
      ? approval.humanSummary
      : '任务正在等待当前对话确认后继续。';
  }
  if (job.status === 'human_attention_required') return '任务需要你的判断后才能继续。';
  return undefined;
}

function childStatusFromResult(job: ExecutionJob): {
  childReference?: ExecutionChildReference;
  childRunStatus?: string;
  childLocalJobStatus?: string;
  delegationAccepted?: boolean;
} {
  const childReference = childReferenceFromJob(job);
  const result = job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : {};
  const localJob = result.localJob && typeof result.localJob === 'object'
    ? result.localJob as Record<string, unknown>
    : result.job && typeof result.job === 'object'
      ? result.job as Record<string, unknown>
      : undefined;
  const childRunStatus = typeof result.childRunStatus === 'string'
    ? result.childRunStatus
    : typeof result.runStatus === 'string'
      ? result.runStatus
      : undefined;
  const childLocalJobStatus = typeof result.childLocalJobStatus === 'string'
    ? result.childLocalJobStatus
    : typeof localJob?.status === 'string'
      ? localJob.status
      : typeof result.status === 'string' && result.delegated === true
        ? result.status
        : undefined;
  const delegationAccepted = result.delegationAccepted === true
    || result.delegated === true
    || (TERMINAL_JOB_STATUSES.has(job.status)
      && job.status === 'succeeded'
      && hasDurableChildReference(childReference)
      && isAgentDelegationOperation(job.payload.operation));
  return {
    ...(childReference ? { childReference } : {}),
    ...(childRunStatus ? { childRunStatus } : {}),
    ...(childLocalJobStatus ? { childLocalJobStatus } : {}),
    ...(delegationAccepted ? { delegationAccepted: true } : {}),
  };
}

export function buildJobOperationDigest(job: ExecutionJob, options: {
  waited?: boolean;
  stillRunning?: boolean;
} = {}): OperationDigest {
  const phase = options.stillRunning ? phaseFromJobStatus(job.status) : phaseFromJobStatus(job.status);
  const terminal = TERMINAL_JOB_STATUSES.has(job.status);
  const operation = typeof job.payload.operation === 'string' ? job.payload.operation : job.type;
  const errorMessage = readableErrorMessage(job);
  const errorClass = errorMessage || job.status === 'failed' || job.status === 'timed_out'
    ? classifyUserFacingError({
      code: job.error?.code,
      message: errorMessage,
      status: job.status,
      infrastructure: job.outcome?.failureClass === 'infrastructure_failure'
        || Boolean(job.outcome?.infrastructureError)
        || job.status === 'orphaned'
        || job.status === 'stale',
      acceptance: job.outcome?.failureClass === 'acceptance_failure'
        || Boolean(job.outcome?.acceptanceFailure),
    })
    : undefined;
  const child = childStatusFromResult(job);

  let summary: string;
  if (child.delegationAccepted && phase === 'succeeded') {
    const runLabel = child.childRunStatus ? `，子 Run 状态 ${child.childRunStatus}` : '';
    const localLabel = !child.childRunStatus && child.childLocalJobStatus
      ? `，Local Job 状态 ${child.childLocalJobStatus}`
      : '';
    summary = `已接受 ${operation} 委派${runLabel}${localLabel}。父 Job 完成不代表 Task 验收通过。`;
  } else if (phase === 'succeeded') {
    const files = extractChangedFiles(job);
    summary = files.length
      ? `已完成 ${operation}，涉及 ${files.length} 个文件。`
      : `已完成 ${operation}。`;
  } else if (phase === 'failed' || phase === 'timed_out' || phase === 'needs_attention' || phase === 'cancelled') {
    summary = errorMessage
      ? `${statusLabelForPhase(phase)}：${errorMessage}`
      : `${statusLabelForPhase(phase)}：${operation}`;
  } else if (options.waited && !terminal) {
    summary = `${operation} 仍在${statusLabelForPhase(phase)}，尚未到终态。`;
  } else {
    summary = `${operation} ${statusLabelForPhase(phase)}。`;
  }

  return {
    schemaVersion: 1,
    phase,
    statusLabel: statusLabelForPhase(phase),
    summary: bound(summary, 500),
    terminal,
    // Keep the legacy field for compatibility; callers must use resultAccepted
    // to decide whether execution/verification succeeded.
    accepted: true,
    requestAccepted: true,
    // Delegation-accepted parent success is not Task/Run result success.
    resultAccepted: terminal
      ? (child.delegationAccepted ? false : phase === 'succeeded')
      : null,
    operation,
    workId: job.jobId,
    jobId: job.jobId,
    requestId: job.requestId,
    changedFiles: extractChangedFiles(job),
    evidenceRefs: job.evidenceIds.slice(-5).map((id) => ({ title: 'evidence', summary: id })),
    errorClass,
    errorMessage,
    suggestedNextActions: defaultNextActions(phase, job.jobId, errorClass),
    rawAvailable: false,
    ...child,
  };
}

export function buildAcceptedQueuedDigest(input: {
  jobId: string;
  requestId?: string;
  operation?: string;
  status?: string;
  deduplicated?: boolean;
}): OperationDigest {
  return {
    schemaVersion: 1,
    phase: 'queued',
    statusLabel: '已排队',
    summary: input.deduplicated
      ? `已复用进行中的任务 ${input.jobId}（${input.operation ?? 'operation'}）。可用 wait 等待结果。`
      : `已接受任务 ${input.jobId}（${input.operation ?? 'operation'}），正在排队。可用 wait 等待结果。`,
    terminal: false,
    accepted: true,
    requestAccepted: true,
    resultAccepted: null,
    operation: input.operation,
    workId: input.jobId,
    jobId: input.jobId,
    requestId: input.requestId,
    suggestedNextActions: [
      {
        label: '等待任务完成',
        tool: 'rh_work',
        operation: 'continue',
        payload: { work_id: input.jobId, wait: true },
        risk: 'readonly',
        confidence: 'high',
        reason: '对长时间任务使用 wait/work_get 获取终态摘要。',
      },
      ...defaultNextActions('queued', input.jobId),
    ],
    rawAvailable: false,
  };
}

export function buildSyncOperationDigest(input: {
  ok: boolean;
  operation: string;
  summary: string;
  changedFiles?: string[];
  errorClass?: UserFacingErrorClass;
  errorMessage?: string;
  suggestedNextActions?: SuggestedNextAction[];
}): OperationDigest {
  const phase: UserFacingPhase = input.ok ? 'succeeded' : 'failed';
  return {
    schemaVersion: 1,
    phase,
    statusLabel: statusLabelForPhase(phase),
    summary: bound(input.summary, 500),
    terminal: true,
    accepted: input.ok,
    requestAccepted: true,
    resultAccepted: input.ok,
    operation: input.operation,
    changedFiles: (input.changedFiles ?? []).slice(0, 30),
    errorClass: input.errorClass,
    errorMessage: input.errorMessage ? bound(input.errorMessage) : undefined,
    suggestedNextActions: input.suggestedNextActions ?? defaultNextActions(phase),
    rawAvailable: false,
  };
}
