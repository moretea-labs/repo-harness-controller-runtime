import type { RepositoryRecord } from '../repositories/types';
import { listControllerChecks, runControllerCheck } from '../controller/check-runner';
import { controllerExpectedToolNames } from '../mcp/tools';
import { runtimePolicy } from '../mcp/multi-repository';
import { readControllerDaemonStatus } from '../../runtime/control-plane/daemon-client';
import {
  getAssistantPluginManifest,
  listAssistantPluginManifests,
} from '../../runtime/plugins/store';
import type { AssistantPluginManifest } from '../../runtime/plugins/types';
import {
  acknowledgeHandoffItem,
  buildFacadeResult,
  buildSyncOperationDigest,
  classifyUserFacingError,
  classifyVerificationOutcome,
  continueGoalWorkloop,
  delegateToCodexCerebellum,
  dismissHandoffItem,
  finalizeGoalWorkloop,
  getHandoffItem,
  getWorkContract,
  listHandoffItems,
  listWorkContracts,
  normalizeCheckIds,
  resolveHandoffItem,
  routeWorkStart,
  runSelfHealingLoop,
  selectExecutionMode,
  stopGoalWorkloop,
  summarizeHandoffItem,
  summarizeWorkContract,
  verifyGoalWorkloop,
  type ExecutionModeSelectionInput,
  type FacadeResult,
  type HandoffItem,
  type SuggestedNextAction,
  type WorkContract,
} from '../../runtime/control-plane/facade';
import { buildRuntimeMaintenanceStatus } from '../../runtime/recovery';
import { applySafePatch } from '../repositories/safe-patch';
import { withControllerLock } from '../repositories/locks';
import {
  buildLocalConnectorStatusForRepo,
  EXPECTED_FACADE_TOOLS,
  type ConnectorFreshnessReport,
} from './connector-freshness';
import {
  statusLabelForPhase,
  type UserFacingErrorClass,
  type UserFacingPhase,
} from '../../runtime/control-plane/facade/operation-digest';
import { repositoryGitStatus } from '../repositories/structured-git';
import type {
  ChangedFileEntryViewModel,
  ChangedFilesSummaryViewModel,
  CommandCenterViewModel,
  ConnectorFreshnessViewModel,
  ConsoleErrorViewModel,
  GoalLoopStatusViewModel,
  HandoffCardViewModel,
  ModePreviewViewModel,
  PlainStatusTone,
  PluginActionViewModel,
  PluginCardViewModel,
  PluginSummaryViewModel,
  RepositoryCardViewModel,
  SuggestedActionViewModel,
  SystemReadinessViewModel,
  VerificationViewModel,
  WorkSummaryViewModel,
} from './console-view-models';
import {
  buildAutomationSettingsView,
  executorRoutePreviewWithConfig,
  executorRoutingConfigGet,
  executorRoutingConfigReset,
  executorRoutingConfigUpdate,
  goalLoopPolicyGet,
  goalLoopPolicyUpdate,
  goalStatus as goalLoopStatusSnapshot,
  localToolDisable,
  localToolEnable,
  localToolHealthCheck,
  localToolList,
  localToolConfigGet,
  localToolConfigUpdate,
  providerApiSettingsGet,
  providerApiSettingsUpdate,
  providerConfigGet,
  providerConfigUpdate,
  providerCredentialsStatus,
  providerDisable,
  providerEnable,
  providerHealthCheck,
  providerPriorityUpdate,
  providerResetDefaults,
  type ConfigFacadeContext,
  type GoalLoopContext,
} from '../../runtime/control-plane/goal-loop';
import { listActiveOccurrences, listSchedules } from '../../runtime/workflow/schedules/store';

export type ConsoleFacadeContext = {
  controllerHome: string;
  repository: RepositoryRecord;
};

function store(ctx: ConsoleFacadeContext) {
  return { controllerHome: ctx.controllerHome, repoId: ctx.repository.repoId };
}

function plainMode(mode: ModePreviewViewModel['mode']): ModePreviewViewModel {
  if (mode === 'direct_control') {
    return {
      mode,
      label: '直接执行',
      explanation: '小范围、目标清晰的改动；适合由 ChatGPT 直接监督完成。',
      createWorkContract: false,
      createHandoff: false,
    };
  }
  if (mode === 'handoff_only') {
    return {
      mode,
      label: '需要你先决定',
      explanation: '目标不清、风险较高或缺少授权；执行前需要你的判断。',
      createWorkContract: false,
      createHandoff: true,
    };
  }
  return {
    mode: 'goal_workloop',
    label: '可恢复的后台任务',
    explanation: '多步骤或需要恢复/隔离的任务；会创建工作项并支持继续、验证与收尾。',
    createWorkContract: true,
    createHandoff: false,
  };
}

function mapSuggested(actions: SuggestedNextAction[] = []): SuggestedActionViewModel[] {
  return actions.slice(0, 8).map((action, index) => {
    const op = action.operation;
    const kind: SuggestedActionViewModel['kind'] =
      op === 'continue' ? 'continue'
        : op === 'verify' ? 'verify'
          : op === 'finalize' ? 'finalize'
            : op === 'stop' ? 'stop'
              : op === 'delegate' ? 'delegate'
                : op === 'repair' || op === 'diagnose' ? 'repair'
                  : op === 'resolve' ? 'resolve'
                    : op === 'dismiss' ? 'dismiss'
                      : op === 'get' || op === 'list' ? 'open'
                        : 'other';
    return {
      id: `${action.tool}-${op}-${index}`,
      label: action.label,
      kind,
      tool: action.tool,
      operation: action.operation,
      payload: action.payload,
      primary: index === 0,
    };
  });
}

function workStatusLabel(status: WorkContract['status']): { label: string; tone: PlainStatusTone; phase: UserFacingPhase } {
  switch (status) {
    case 'running': return { label: '进行中', tone: 'blue', phase: 'running' };
    case 'pending': return { label: '待开始', tone: 'gray', phase: 'queued' };
    case 'blocked': return { label: '已阻塞', tone: 'red', phase: 'blocked' };
    case 'waiting_for_review': return { label: '需要你审阅', tone: 'amber', phase: 'needs_attention' };
    case 'succeeded': return { label: '已完成', tone: 'green', phase: 'succeeded' };
    case 'failed': return { label: '未通过验收', tone: 'red', phase: 'failed' };
    case 'cancelled': return { label: '已停止', tone: 'gray', phase: 'cancelled' };
    default: return { label: String(status), tone: 'gray', phase: 'running' };
  }
}

const ERROR_COPY: Record<UserFacingErrorClass, { title: string; explanation: string; nextActions: string[] }> = {
  controller_unavailable: {
    title: '控制器暂不可用',
    explanation: '后台控制器未就绪，暂时无法执行任务。',
    nextActions: ['查看系统状态', '运行诊断', '重启 controller'],
  },
  connector_stale: {
    title: '连接器可能过期',
    explanation: '本地 MCP 与 ChatGPT 工具快照可能不一致；若 ChatGPT 里看不到 rh_* 请重连。',
    nextActions: ['查看连接器诊断', '重启 MCP', '重连 ChatGPT Connector'],
  },
  infrastructure_failure: {
    title: '环境/基础设施问题',
    explanation: '失败来自运行环境（进程、存储、检查命令），不是业务验收本身。',
    nextActions: ['运行修复诊断', '查看高级诊断', '稍后重试'],
  },
  acceptance_failure: {
    title: '验收未通过',
    explanation: '检查已运行，但结果不符合验收标准。',
    nextActions: ['查看失败原因', '继续修改', '再次验证'],
  },
  invalid_check_id: {
    title: '检查项无效',
    explanation: '指定的检查 ID 未注册或不存在。',
    nextActions: ['选择有效检查', '查看系统状态'],
  },
  approval_required: {
    title: '需要你授权',
    explanation: '该操作风险较高，需明确授权后才能继续。',
    nextActions: ['查看待决定', '确认后继续'],
  },
  handoff_required: {
    title: '需要你做决定',
    explanation: '任务停在决策点，不能自动往下走。',
    nextActions: ['打开待决定', '记录决定后继续'],
  },
  timeout: {
    title: '执行超时',
    explanation: '操作在限定时间内未完成。',
    nextActions: ['重试', '运行诊断', '查看高级详情'],
  },
  policy_denied: {
    title: '策略拒绝',
    explanation: '当前策略不允许该操作。',
    nextActions: ['调整范围', '查看高级诊断'],
  },
  not_found: {
    title: '未找到目标',
    explanation: '任务、仓库或资源不存在或已清理。',
    nextActions: ['刷新控制台', '重新选择仓库或任务'],
  },
  unknown_failure: {
    title: '出现未知错误',
    explanation: '操作失败，但尚未归类到具体原因。',
    nextActions: ['重试', '运行诊断', '查看高级详情'],
  },
};

export function describeConsoleError(
  errorClass: UserFacingErrorClass,
  detail?: string,
): ConsoleErrorViewModel {
  const copy = ERROR_COPY[errorClass] ?? ERROR_COPY.unknown_failure;
  const explanation = detail && detail.trim() && detail.trim() !== 'undefined'
    ? `${copy.explanation} ${detail.trim().slice(0, 180)}`
    : copy.explanation;
  return {
    errorClass,
    title: copy.title,
    explanation,
    nextActions: copy.nextActions,
  };
}

export function summarizeChangedFiles(paths: readonly string[]): ChangedFilesSummaryViewModel | undefined {
  const unique = [...new Set(paths.map((entry) => String(entry || '').trim()).filter(Boolean))].slice(0, 40);
  if (!unique.length) return undefined;
  const files: ChangedFileEntryViewModel[] = unique.map((path) => {
    let status: ChangedFileEntryViewModel['status'] = 'modified';
    if (path.startsWith('A ') || path.includes('(new)') || path.startsWith('+')) status = 'added';
    else if (path.startsWith('D ') || path.includes('(deleted)') || path.startsWith('-')) status = 'deleted';
    else if (path.startsWith('R ') || path.includes(' -> ')) status = 'renamed';
    const clean = path.replace(/^[AMD?R]\s+/, '').replace(/^\+/, '').replace(/^-/, '').trim();
    return {
      path: clean || path,
      status,
      statusLabel: status === 'added' ? '新增' : status === 'deleted' ? '删除' : status === 'renamed' ? '重命名' : '修改',
    };
  });
  const added = files.filter((entry) => entry.status === 'added').length;
  const deleted = files.filter((entry) => entry.status === 'deleted').length;
  const modified = files.length - added - deleted;
  const parts: string[] = [];
  if (modified) parts.push(`修改 ${modified}`);
  if (added) parts.push(`新增 ${added}`);
  if (deleted) parts.push(`删除 ${deleted}`);
  if (!parts.length) parts.push(`${files.length} 个文件`);
  return {
    total: files.length,
    modified,
    added,
    deleted,
    files,
    summaryLabel: parts.join(' · '),
  };
}

function extractChangedPathsFromWork(
  work: WorkContract,
  opts: { controllerHome: string; repoId: string } | null = null,
): string[] {
  const paths: string[] = [];
  for (const evidence of work.evidenceRefs ?? []) {
    const blob = `${evidence.title ?? ''} ${evidence.summary ?? ''}`;
    for (const match of blob.matchAll(/(?:^|[\s`])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:$|[\s`,])/g)) {
      if (match[1] && !match[1].startsWith('http')) paths.push(match[1]);
    }
  }
  if (opts) {
    for (const handoffId of work.handoffRefs ?? []) {
      try {
        const item = getHandoffItem({ controllerHome: opts.controllerHome, repoId: opts.repoId }, handoffId);
        for (const path of item?.currentState?.changedFiles ?? []) {
          if (path) paths.push(path);
        }
      } catch {
        // ignore missing handoffs
      }
    }
  }
  return paths;
}

function progressSteps(work: WorkContract): WorkSummaryViewModel['progressSteps'] {
  const checks = work.checkRefs ?? [];
  const hasPass = checks.some((entry) => entry.outcome === 'valid_pass');
  const hasFail = checks.some((entry) => entry.outcome === 'valid_fail');
  const hasDelegate = Boolean(work.workerRef);
  const review = work.status === 'waiting_for_review';
  const done = work.status === 'succeeded';
  const failed = work.status === 'failed';
  const cancelled = work.status === 'cancelled';
  return [
    { label: '已开始', done: true, active: work.status === 'running' && !hasDelegate && !hasPass },
    { label: '已委派助手', done: hasDelegate, active: hasDelegate && !hasPass && !review },
    { label: '已提出修改', done: hasDelegate || hasPass || hasFail, active: false },
    { label: '已验证', done: hasPass || hasFail, active: hasFail && !review },
    { label: '等待审阅', done: review || done, active: review },
    { label: done ? '已完成' : failed ? '验收失败' : cancelled ? '已停止' : '收尾', done: done || failed || cancelled, active: false },
  ];
}

function latestVerification(work: WorkContract): VerificationViewModel | undefined {
  const record = work.checkRefs[0];
  if (!record) return undefined;
  const isAcceptanceFailure = record.outcome === 'valid_fail';
  const isInfrastructureIssue = record.outcome === 'infrastructure_failure' || record.outcome === 'invalid_check_id';
  const tone: PlainStatusTone = record.outcome === 'valid_pass' ? 'green'
    : isAcceptanceFailure ? 'red'
      : isInfrastructureIssue ? 'amber'
        : 'gray';
  const label = record.outcome === 'valid_pass' ? '检查通过'
    : record.outcome === 'valid_fail' ? '检查未通过'
      : record.outcome === 'infrastructure_failure' ? '环境问题'
        : record.outcome === 'invalid_check_id' ? '检查项无效'
          : record.outcome === 'superseded' ? '已被后续结果覆盖'
            : '已跳过';
  return {
    label,
    tone,
    outcome: record.outcome,
    checkLabel: record.checkId,
    isAcceptanceFailure,
    isInfrastructureIssue,
    summary: record.summary,
  };
}

export function mapWorkSummary(
  work: WorkContract,
  opts: { controllerHome?: string; repoId?: string } = {},
): WorkSummaryViewModel {
  const status = workStatusLabel(work.status);
  const mode = plainMode(work.mode === 'direct_control' || work.mode === 'handoff_only' ? work.mode : 'goal_workloop');
  const verification = latestVerification(work);
  const suggested = mapSuggested(work.suggestedNextActions);
  const nextAction = suggested[0]?.label
    ?? (work.status === 'waiting_for_review' ? '请审阅后继续或收尾'
      : work.status === 'running' ? '继续或运行检查'
        : work.status === 'succeeded' ? '任务已完成'
          : work.status === 'failed' ? '查看失败原因并决定是否重试'
            : '查看任务状态');
  const storeOpts = opts.controllerHome && opts.repoId
    ? { controllerHome: opts.controllerHome, repoId: opts.repoId }
    : null;
  const changedFiles = summarizeChangedFiles(extractChangedPathsFromWork(work, storeOpts));
  let error: ConsoleErrorViewModel | undefined;
  if (work.status === 'failed') {
    error = describeConsoleError(
      verification?.isInfrastructureIssue ? 'infrastructure_failure' : 'acceptance_failure',
      verification?.summary,
    );
  } else if (work.status === 'blocked' || work.status === 'waiting_for_review') {
    error = describeConsoleError(
      work.status === 'waiting_for_review' ? 'handoff_required' : 'handoff_required',
      work.suggestedNextActions[0]?.reason,
    );
  }
  const latestSummary = verification?.summary
    || work.evidenceRefs[0]?.summary
    || work.evidenceRefs[0]?.title
    || (work.status === 'running' ? '任务执行中…' : status.label);
  return {
    id: work.workId,
    title: work.objective.slice(0, 160) || '未命名任务',
    objective: work.objective,
    modeLabel: mode.label,
    mode: mode.mode,
    statusLabel: status.label,
    tone: status.tone,
    phase: status.phase,
    phaseLabel: statusLabelForPhase(status.phase),
    nextAction,
    latestAction: suggested[0]?.label || nextAction,
    latestSummary,
    progressSteps: progressSteps(work),
    latestVerification: verification,
    acceptanceCriteria: work.acceptanceCriteria.slice(0, 8),
    evidenceLabels: work.evidenceRefs.slice(0, 6).map((entry) => entry.title || entry.summary || '证据'),
    changedFiles,
    error,
    delegateSummary: work.workerRef
      ? `已委派小助手（${work.workerRef.split(':')[0] ?? 'worker'}），等待 ChatGPT 审阅后才能收尾。`
      : undefined,
    suggestedActions: suggested,
    primaryActionLabel: suggested[0]?.label,
    advanced: {
      workId: work.workId,
      status: work.status,
      checkIds: work.checks,
      handoffRefs: work.handoffRefs,
    },
  };
}

function handoffTone(severity: HandoffItem['severity']): PlainStatusTone {
  if (severity === 'blocked' || severity === 'failed') return 'red';
  if (severity === 'needs_review') return 'amber';
  if (severity === 'ready_to_continue') return 'green';
  return 'blue';
}

export function mapHandoffCard(item: HandoffItem): HandoffCardViewModel {
  return {
    id: item.id,
    title: item.title,
    reason: item.reason,
    recommendedDecision: item.recommendedDecision,
    continuationPrompt: item.recommendedContinuationPrompt || item.recommendedPrompt,
    severityLabel: item.severity === 'needs_review' ? '需要判断'
      : item.severity === 'blocked' ? '已阻塞'
        : item.severity === 'failed' ? '失败'
          : item.severity === 'ready_to_continue' ? '可继续'
            : '提示',
    tone: handoffTone(item.severity),
    statusLabel: item.status === 'pending' ? '待处理'
      : item.status === 'acknowledged' ? '已确认'
        : item.status === 'resolved' ? '已解决'
          : item.status === 'dismissed' ? '已忽略'
            : item.status,
    workTitle: item.currentState.statusSummary,
    attemptedActions: item.attemptedActions ?? [],
    evidenceLabels: item.evidenceRefs.map((entry) => entry.title || '证据').slice(0, 6),
    suggestedActions: mapSuggested(item.suggestedNextActions),
    advanced: {
      handoffId: item.id,
      workId: item.workId,
      creationReason: item.creationReason,
    },
  };
}

export function previewExecutionMode(input: ExecutionModeSelectionInput & { objective?: string }): ModePreviewViewModel {
  const selection = selectExecutionMode(input);
  return {
    ...plainMode(selection.mode),
    createWorkContract: selection.createWorkContract,
    createHandoff: selection.createHandoff,
    explanation: selection.reason.includes('Small') || selection.reason.includes('small')
      ? plainMode(selection.mode).explanation
      : plainMode(selection.mode).explanation,
  };
}

function displayPath(path: string): string {
  const home = process.env.HOME?.trim();
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export function mapRepositoryCard(
  repository: RepositoryRecord,
  current: boolean,
): RepositoryCardViewModel {
  let branchLabel: string | undefined;
  let dirtyLabel: string | undefined;
  let readinessLabel: string | undefined;
  if (current || repository.enabled !== false) {
    try {
      const git = repositoryGitStatus(repository);
      branchLabel = git.branch || repository.defaultBranch || 'detached';
      dirtyLabel = git.clean ? '工作区干净' : '有未提交变更';
      readinessLabel = repository.enabled === false ? '已停用' : git.clean ? '可执行' : '可执行（脏工作区）';
    } catch {
      branchLabel = repository.defaultBranch || undefined;
      readinessLabel = repository.enabled === false ? '已停用' : '可用';
    }
  }
  return {
    id: repository.repoId,
    name: repository.displayName || repository.repoId,
    path: displayPath(repository.canonicalRoot),
    statusLabel: current ? '当前' : repository.enabled === false ? '已停用' : '可用',
    tone: current ? 'green' : repository.enabled === false ? 'gray' : 'blue',
    current,
    branchLabel,
    dirtyLabel,
    readinessLabel,
    advanced: {
      repoId: repository.repoId,
      remote: repository.remoteUrl,
      defaultBranch: repository.defaultBranch,
      checkoutId: repository.activeCheckoutId,
    },
  };
}

function mapConnectorFreshnessView(report: ConnectorFreshnessReport): ConnectorFreshnessViewModel {
  return {
    status: report.status,
    severity: report.severity,
    summary: report.summary,
    expectedFacadeTools: report.expectedFacadeTools,
    missingLocalTools: report.missingLocalTools,
    missingConnectorTools: report.missingConnectorTools,
    restartRecommended: report.restartRecommended,
    reconnectRecommended: report.reconnectRecommended,
    howToFix: report.howToFix,
    suggestedActions: report.suggestedActions,
  };
}

/**
 * Evaluate local MCP tool-surface freshness for the console.
 * Probes live MCP /health; does not invent ChatGPT connector tool names.
 */
export async function evaluateConsoleConnectorFreshness(
  ctx: ConsoleFacadeContext,
  opts: { connectorToolNames?: readonly string[] | null; refreshRuntimeFile?: boolean } = {},
): Promise<ConnectorFreshnessReport> {
  const expected = controllerExpectedToolNames(
    runtimePolicy(ctx.repository.canonicalRoot, { profile: 'controller' }),
  );
  return buildLocalConnectorStatusForRepo({
    repoRoot: ctx.repository.canonicalRoot,
    expectedTools: expected,
    connectorToolNames: opts.connectorToolNames,
    refreshRuntimeFile: opts.refreshRuntimeFile,
  });
}

export async function buildSystemReadiness(
  ctx: ConsoleFacadeContext,
  opts: { connectorToolNames?: readonly string[] | null } = {},
): Promise<SystemReadinessViewModel> {
  const daemon = readControllerDaemonStatus(ctx.controllerHome);
  const freshness = await evaluateConsoleConnectorFreshness(ctx, opts);
  const pendingHandoffs = listHandoffItems({ ...store(ctx), status: 'pending', limit: 50 });
  const checks = listControllerChecks(ctx.repository.canonicalRoot);
  const automation = buildAutomationReadinessSection(ctx);
  const sections: SystemReadinessViewModel['sections'] = [
    {
      id: 'controller',
      title: '控制器',
      statusLabel: daemon.status === 'ready' ? '就绪' : '未就绪',
      tone: daemon.status === 'ready' ? 'green' : 'red',
      detail: daemon.status === 'ready' ? '后台控制器可接受任务。' : `控制器状态：${daemon.status}`,
    },
    {
      id: 'connector',
      title: 'ChatGPT 连接',
      statusLabel: freshness.sectionStatusLabel,
      tone: freshness.connectorTone,
      detail: freshness.sectionDetail,
    },
    {
      id: 'bridge',
      title: '本地控制台',
      statusLabel: '运行中',
      tone: 'green',
      detail: '本地控制台服务可用。',
    },
    {
      id: 'repository',
      title: '仓库',
      statusLabel: ctx.repository.enabled === false ? '不可用' : '可用',
      tone: ctx.repository.enabled === false ? 'red' : 'green',
      detail: displayPath(ctx.repository.canonicalRoot),
    },
    {
      id: 'checks',
      title: '检查项',
      statusLabel: checks.length ? `${checks.length} 个可用` : '未配置',
      tone: checks.length ? 'green' : 'amber',
      detail: checks.length ? '可运行注册检查验证结果。' : '尚未发现可用检查脚本。',
    },
    {
      id: 'handoffs',
      title: '待你决定',
      statusLabel: pendingHandoffs.length ? `${pendingHandoffs.length} 项` : '无',
      tone: pendingHandoffs.length ? 'amber' : 'green',
      detail: pendingHandoffs.length ? '有事项需要你的判断后才能继续。' : '没有待处理决策。',
    },
    automation,
  ];
  const blocked = daemon.status !== 'ready';
  const needsSetup = ctx.repository.enabled === false;
  const state: SystemReadinessViewModel['state'] = blocked ? 'blocked' : needsSetup ? 'needs_setup' : 'ready';
  return {
    state,
    label: state === 'ready' ? '就绪' : state === 'needs_setup' ? '需要设置' : '暂不可用',
    headline: state === 'ready' ? '系统可用' : state === 'needs_setup' ? '完成设置后即可开始' : '系统暂不可用',
    description: state === 'ready'
      ? '你可以输入自然语言任务，或先处理待决定事项。'
      : state === 'needs_setup'
        ? '请先选择或注册一个可用仓库。'
        : '请先查看系统状态并尝试诊断/修复。',
    connectorLabel: freshness.connectorLabel,
    connectorTone: freshness.connectorTone,
    connectorFreshness: mapConnectorFreshnessView(freshness),
    pendingHandoffCount: pendingHandoffs.length,
    sections,
  };
}

function buildAutomationReadinessSection(
  ctx: ConsoleFacadeContext,
): SystemReadinessViewModel['sections'][number] {
  const schedules = listSchedules(ctx.controllerHome, ctx.repository.repoId).filter((schedule) => schedule.enabled);
  const shadowSchedules = schedules.filter((schedule) => schedule.policy.shadowMode);
  const liveSchedules = schedules.filter((schedule) => !schedule.policy.shadowMode);
  const liveScheduleIds = new Set(liveSchedules.map((schedule) => schedule.scheduleId));
  const activeLiveOccurrences = listActiveOccurrences(ctx.controllerHome, ctx.repository.repoId)
    .filter((occurrence) => liveScheduleIds.has(occurrence.scheduleId)
      && ['created', 'queued', 'running'].includes(occurrence.status))
    .length;

  if (schedules.length === 0) {
    return {
      id: 'automation',
      title: '自治调度',
      statusLabel: '未配置',
      tone: 'gray',
      detail: '当前“就绪”只表示控制器可以接受任务；没有启用中的 live schedule 在后台自治执行。',
    };
  }

  if (liveSchedules.length === 0) {
    return {
      id: 'automation',
      title: '自治调度',
      statusLabel: `${shadowSchedules.length} 个影子计划`,
      tone: 'amber',
      detail: '已启用的 schedule 全部处于 shadow mode：它们只记录 would_execute / shadowed 结果，不会排队或启动 Execution Job。',
    };
  }

  const liveLabel = shadowSchedules.length > 0
    ? `live ${liveSchedules.length} / shadow ${shadowSchedules.length}`
    : `${liveSchedules.length} 个 live 计划`;
  const liveDetail = activeLiveOccurrences > 0
    ? `当前有 ${activeLiveOccurrences} 个 live occurrence 正在 created/queued/running。`
    : '当前没有 live occurrence 在 created/queued/running。';
  return {
    id: 'automation',
    title: '自治调度',
    statusLabel: liveLabel,
    tone: 'green',
    detail: `只有 live schedule 在触发条件满足时才会排队 bounded execution。${shadowSchedules.length > 0 ? ' shadow schedule 仍然只做记录。' : ''} ${liveDetail}`,
  };
}

function riskLabel(risk: string): string {
  if (risk === 'readonly') return '只读';
  if (risk === 'workspace_write') return '本地写入';
  if (risk === 'remote_write') return '远程写入';
  if (risk === 'destructive') return '破坏性';
  return risk || '未知';
}

function confirmationLabel(confirmation: string): string {
  if (confirmation === 'none') return '无需确认';
  if (confirmation === 'authorization') return '需要授权确认';
  if (confirmation === 'strong_confirmation') return '需要强确认';
  return confirmation || '未知';
}

function mapPluginAction(action: AssistantPluginManifest['actions'][number]): PluginActionViewModel {
  return {
    id: action.actionId,
    title: action.title || action.actionId,
    description: action.description || '',
    risk: action.risk,
    riskLabel: riskLabel(action.risk),
    readOnly: action.readOnly === true || action.risk === 'readonly',
    confirmation: action.confirmation,
    confirmationLabel: confirmationLabel(action.confirmation),
    canPreview: action.readOnly === true || action.risk === 'readonly' || action.actionId === 'configure' || action.actionId === 'auth_status',
    requiredConfirmationText: action.requiredConfirmationText,
  };
}

export function mapPluginCard(manifest: AssistantPluginManifest): PluginCardViewModel {
  const health = manifest.health;
  const lifecycle = manifest.lifecycle;
  const ready = manifest.enabled !== false
    && health.ready !== false
    && health.state !== 'error'
    && lifecycle.state !== 'error';
  const needsAuthorization = [...(health.errors ?? []), ...(health.warnings ?? []), lifecycle.reason ?? '']
    .some((entry) => /auth|token|credential|permission|scope|授权|登录/i.test(String(entry)));
  const status: PluginCardViewModel['status'] = manifest.enabled === false
    ? 'disabled'
    : ready
      ? 'ready'
      : needsAuthorization
        ? 'authorization_required'
        : health.state === 'error' || lifecycle.state === 'error'
          ? 'failed'
          : 'needs_setup';
  const tone: PlainStatusTone = status === 'ready'
    ? 'green'
    : status === 'failed'
      ? 'red'
      : status === 'disabled'
        ? 'gray'
        : 'amber';
  const nextStep = status === 'ready'
    ? '已连接，可用于任务执行'
    : status === 'authorization_required'
      ? '需要完成授权后才能使用'
      : status === 'disabled'
        ? '插件已禁用'
        : '需要配置并测试连接';
  const actions = manifest.actions.map(mapPluginAction);
  return {
    id: manifest.pluginId,
    name: manifest.displayName || manifest.pluginId,
    provider: manifest.provider,
    status,
    statusLabel: status === 'ready'
      ? '可用'
      : status === 'authorization_required'
        ? '待授权'
        : status === 'failed'
          ? '异常'
          : status === 'disabled'
            ? '已禁用'
            : '需配置',
    tone,
    enabled: manifest.enabled !== false,
    actionCount: actions.length,
    description: `${actions.length} 个可用动作 · ${manifest.provider}`,
    nextStep,
    healthLabel: health.state || 'unknown',
    lifecycleLabel: lifecycle.state || 'unknown',
    capabilityLabels: (manifest.capabilities ?? []).slice(0, 6).map((entry) => entry.title || entry.capabilityId),
    actions,
    warnings: [...(health.warnings ?? []), ...(health.errors ?? [])].slice(0, 6).map(String),
    advanced: {
      pluginId: manifest.pluginId,
      provider: manifest.provider,
      revision: manifest.revision,
    },
  };
}

export function listConsolePlugins(ctx: ConsoleFacadeContext): PluginCardViewModel[] {
  return listAssistantPluginManifests(ctx.controllerHome, ctx.repository).map(mapPluginCard);
}

export function getConsolePlugin(ctx: ConsoleFacadeContext, pluginId: string): PluginCardViewModel | null {
  try {
    return mapPluginCard(getAssistantPluginManifest(ctx.controllerHome, ctx.repository, pluginId));
  } catch {
    return null;
  }
}

export function buildPluginSummary(plugins: PluginCardViewModel[]): PluginSummaryViewModel {
  const ready = plugins.filter((entry) => entry.status === 'ready').length;
  const needsAttention = plugins.filter((entry) =>
    entry.status === 'authorization_required' || entry.status === 'failed' || entry.status === 'needs_setup').length;
  return {
    ready,
    total: plugins.length,
    needsAttention,
    lines: plugins.slice(0, 6).map((entry) => `${entry.name} · ${entry.statusLabel}`),
  };
}

export async function buildCommandCenter(
  ctx: ConsoleFacadeContext,
  repositories: RepositoryCardViewModel[],
): Promise<CommandCenterViewModel> {
  const readiness = await buildSystemReadiness(ctx);
  const mapWork = (work: WorkContract) => mapWorkSummary(work, {
    controllerHome: ctx.controllerHome,
    repoId: ctx.repository.repoId,
  });
  const currentRepository = repositories.find((entry) => entry.current) ?? mapRepositoryCard(ctx.repository, true);
  const activeWork = listWorkContracts({ ...store(ctx), status: 'active', limit: 20 }).map(mapWork);
  const allRecent = listWorkContracts({ ...store(ctx), status: 'all', limit: 12 }).map(mapWork);
  const handoffs = listHandoffItems({ ...store(ctx), status: 'pending', limit: 20 }).map(mapHandoffCard);
  const plugins = listConsolePlugins(ctx);
  const pluginSummary = buildPluginSummary(plugins);
  const goalLoop = buildGoalLoopStatusView(ctx);
  const banner = readiness.connectorFreshness?.severity === 'warning' || readiness.connectorFreshness?.severity === 'error'
    ? readiness.connectorFreshness.summary
    : undefined;
  const needsSetup = readiness.state === 'needs_setup' || ctx.repository.enabled === false || !currentRepository;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readiness,
    currentRepository,
    repositories,
    currentWork: activeWork[0],
    recentWork: allRecent,
    handoffs,
    goalLoop,
    pluginSummary,
    plugins,
    modePreviewDefault: plainMode('direct_control'),
    // Only surface confirmed warnings — never "maybe missing" when ChatGPT snapshot is unobserved.
    warnings: banner ? [banner] : [],
    setupGuide: needsSetup
      ? {
        needed: true,
        title: '先选择或注册一个仓库',
        body: '没有可用仓库时，无法开始开发任务。请在“仓库”页添加本地 Git 仓库并设为当前。',
        actionLabel: '去设置仓库',
      }
      : { needed: false, title: '', body: '', actionLabel: '' },
  };
}

function configCtx(ctx: ConsoleFacadeContext): ConfigFacadeContext {
  return { controllerHome: ctx.controllerHome };
}

export function buildGoalLoopStatusView(ctx: ConsoleFacadeContext): GoalLoopStatusViewModel {
  const goalCtx: GoalLoopContext = {
    goalStore: store(ctx),
    packetStore: store(ctx),
    repoId: ctx.repository.repoId,
    configLocation: { controllerHome: ctx.controllerHome },
    providerEnv: { configLocation: { controllerHome: ctx.controllerHome } },
  };
  const snapshot = goalLoopStatusSnapshot(goalCtx) as {
    activeGoals?: Array<Record<string, unknown>>;
    activeCount?: number;
    invokableProviders?: string[];
    handoffOnlyProviders?: string[];
    providers?: Array<Record<string, unknown>>;
  };
  let automationSummary: string | undefined;
  let liveEffective: boolean | undefined;
  try {
    const settings = buildAutomationSettingsView(configCtx(ctx));
    automationSummary = settings.overview.plainLanguageSummary;
    liveEffective = settings.overview.liveModelProvidersEffective;
  } catch {
    automationSummary = undefined;
  }

  const goals = (snapshot.activeGoals ?? []).map((goal) => {
    const stage = String(goal.stage ?? '');
    const providerSelected = typeof goal.providerSelected === 'string' ? goal.providerSelected : undefined;
    const waitingReason = typeof goal.waitingReason === 'string' ? goal.waitingReason : undefined;
    const nextSafeAction = typeof goal.nextSafeAction === 'string' ? goal.nextSafeAction : undefined;
    const handoffPacketAvailable = goal.handoffPacketAvailable === true;
    return {
      title: String(goal.title ?? ''),
      stage,
      currentStep: String(goal.currentStep ?? ''),
      providerSelected,
      waitingReason,
      nextSafeAction,
      handoffPacketAvailable,
      approvalRequired: Boolean(waitingReason) || stage === 'waiting_for_user',
      whyThisProvider: providerSelected
        ? `Last selected provider: ${providerSelected}`
        : 'No provider selected yet',
      whatHappensNext: nextSafeAction
        ?? (handoffPacketAvailable
          ? 'Open handoff packet or configure a direct provider'
          : 'Wait for next daemon tick or open Automation Settings'),
      whatIsBlocked: waitingReason
        ?? (stage === 'handoff_ready'
          ? 'Waiting for handoff supervisor (ChatGPT is not auto-invokable)'
          : undefined),
    };
  });
  return {
    activeCount: snapshot.activeCount ?? goals.length,
    goals,
    invokableProviders: snapshot.invokableProviders ?? [],
    handoffOnlyProviders: snapshot.handoffOnlyProviders ?? [],
    providerHealth: (snapshot.providers ?? []).map((provider) => ({
      providerId: String(provider.providerId ?? ''),
      status: String(provider.status ?? ''),
      directDispatchAllowed: provider.directDispatchAllowed === true,
      handoffOnly: provider.handoffOnly === true,
      summary: String(provider.summary ?? ''),
    })),
    automationSummary,
    liveModelProvidersEffective: liveEffective,
    settingsPathHint: 'Model & Tool Providers',
    nextTickHint: 'Daemon ticks active goals about every 5 seconds when the controller is running.',
  };
}

export function getAutomationSettings(ctx: ConsoleFacadeContext) {
  return buildAutomationSettingsView(configCtx(ctx));
}

export function consoleProviderConfigGet(ctx: ConsoleFacadeContext) {
  return providerConfigGet(configCtx(ctx));
}

export function consoleProviderConfigUpdate(ctx: ConsoleFacadeContext, body: Record<string, unknown>) {
  return providerConfigUpdate(configCtx(ctx), body as unknown as Parameters<typeof providerConfigUpdate>[1]);
}

export function consoleProviderEnable(ctx: ConsoleFacadeContext, providerId: string) {
  return providerEnable(configCtx(ctx), providerId);
}

export function consoleProviderDisable(ctx: ConsoleFacadeContext, providerId: string) {
  return providerDisable(configCtx(ctx), providerId);
}

export function consoleProviderPriority(ctx: ConsoleFacadeContext, providerId: string, direction: 'up' | 'down' | number) {
  return providerPriorityUpdate(configCtx(ctx), providerId, direction);
}

export function consoleProviderHealth(ctx: ConsoleFacadeContext, providerId?: string) {
  return providerHealthCheck(configCtx(ctx), providerId);
}

export function consoleProviderCredentials(ctx: ConsoleFacadeContext) {
  return providerCredentialsStatus(configCtx(ctx));
}

export function consoleProviderReset(ctx: ConsoleFacadeContext) {
  return providerResetDefaults(configCtx(ctx));
}

export function consoleProviderApiSettingsGet(ctx: ConsoleFacadeContext, providerId: string) {
  return providerApiSettingsGet(configCtx(ctx), providerId);
}

export function consoleProviderApiSettingsUpdate(
  ctx: ConsoleFacadeContext,
  providerId: string,
  body: Record<string, unknown>,
) {
  return providerApiSettingsUpdate(configCtx(ctx), providerId, {
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : typeof body.base_url === 'string' ? body.base_url : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    apiKey: typeof body.apiKey === 'string'
      ? body.apiKey
      : typeof body.api_key === 'string'
        ? body.api_key
        : undefined,
    clearApiKey: body.clearApiKey === true || body.clear_api_key === true,
  });
}

export function consoleLocalToolList(ctx: ConsoleFacadeContext) {
  return localToolList(configCtx(ctx));
}

export function consoleLocalToolEnable(ctx: ConsoleFacadeContext, toolId: string) {
  return localToolEnable(configCtx(ctx), toolId);
}

export function consoleLocalToolDisable(ctx: ConsoleFacadeContext, toolId: string) {
  return localToolDisable(configCtx(ctx), toolId);
}

export function consoleLocalToolHealth(ctx: ConsoleFacadeContext, toolId?: string) {
  return localToolHealthCheck(configCtx(ctx), toolId);
}

export function consoleLocalToolConfigGet(ctx: ConsoleFacadeContext) {
  return localToolConfigGet(configCtx(ctx));
}

export function consoleLocalToolConfigUpdate(ctx: ConsoleFacadeContext, body: Record<string, unknown>) {
  return localToolConfigUpdate(configCtx(ctx), body as unknown as Parameters<typeof localToolConfigUpdate>[1]);
}

export function consoleRoutingGet(ctx: ConsoleFacadeContext) {
  return executorRoutingConfigGet(configCtx(ctx));
}

export function consoleRoutingUpdate(ctx: ConsoleFacadeContext, body: Record<string, unknown>) {
  return executorRoutingConfigUpdate(configCtx(ctx), body as unknown as Parameters<typeof executorRoutingConfigUpdate>[1]);
}

export function consoleRoutingReset(ctx: ConsoleFacadeContext) {
  return executorRoutingConfigReset(configCtx(ctx));
}

export function consoleRoutePreview(ctx: ConsoleFacadeContext, body: Record<string, unknown> = {}) {
  return executorRoutePreviewWithConfig(configCtx(ctx), {
    taskIntent: typeof body.taskIntent === 'string' ? body.taskIntent as never : typeof body.task_intent === 'string' ? body.task_intent as never : undefined,
    risk: typeof body.risk === 'string' ? body.risk as never : undefined,
    objective: typeof body.objective === 'string' ? body.objective : undefined,
    externalWrite: body.externalWrite === true || body.external_write === true,
  });
}

export function consoleGoalLoopPolicyGet(ctx: ConsoleFacadeContext) {
  return goalLoopPolicyGet(configCtx(ctx));
}

export function consoleGoalLoopPolicyUpdate(ctx: ConsoleFacadeContext, body: Record<string, unknown>) {
  return goalLoopPolicyUpdate(configCtx(ctx), body as unknown as Parameters<typeof goalLoopPolicyUpdate>[1]);
}

export function startConsoleWork(
  ctx: ConsoleFacadeContext,
  input: {
    objective: string;
    acceptanceCriteria?: string[];
    allowedPaths?: string[];
    forbiddenPaths?: string[];
    expectedFiles?: number;
    expectedChangedLines?: number;
    scopeClear?: boolean;
    requiresInvestigation?: boolean;
    requiresLongRunningChecks?: boolean;
    requiresWorker?: boolean;
    requiresApproval?: boolean;
    destructive?: boolean;
    checkIds?: string[];
  },
): FacadeResult {
  const checks = listControllerChecks(ctx.repository.canonicalRoot);
  return routeWorkStart(
    {
      workStore: store(ctx),
      handoffStore: store(ctx),
      repoId: ctx.repository.repoId,
      availableChecks: checks,
    },
    {
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      allowedPaths: input.allowedPaths,
      forbiddenPaths: input.forbiddenPaths,
      checks: input.checkIds,
      modeInput: {
        objective: input.objective,
        expectedFiles: input.expectedFiles,
        expectedChangedLines: input.expectedChangedLines,
        scopeClear: input.scopeClear !== false,
        requiresInvestigation: input.requiresInvestigation === true,
        requiresLongRunningChecks: input.requiresLongRunningChecks === true,
        requiresWorker: input.requiresWorker === true,
        requiresApproval: input.requiresApproval === true,
        destructive: input.destructive === true,
      },
      requestedBy: 'user',
    },
  );
}

export function continueConsoleWork(ctx: ConsoleFacadeContext, workId: string, note?: string): FacadeResult {
  return continueGoalWorkloop(
    {
      workStore: store(ctx),
      handoffStore: store(ctx),
      repoId: ctx.repository.repoId,
      availableChecks: listControllerChecks(ctx.repository.canonicalRoot),
    },
    { workId, note },
  );
}

export function verifyConsoleWork(
  ctx: ConsoleFacadeContext,
  input: { workId: string; checkId?: string; simulate?: boolean; checkFailed?: boolean; infrastructureFailed?: boolean },
): FacadeResult {
  const checks = listControllerChecks(ctx.repository.canonicalRoot);
  const workloopCtx = {
    workStore: store(ctx),
    handoffStore: store(ctx),
    repoId: ctx.repository.repoId,
    availableChecks: checks,
  };
  const work = getWorkContract(store(ctx), input.workId);
  const requested = input.checkId || work?.checks[0] || checks[0]?.id || '';
  const classified = classifyVerificationOutcome({ checkId: requested, available: checks });
  if (classified.outcome === 'invalid_check_id') {
    return verifyGoalWorkloop(workloopCtx, { workId: input.workId, checkId: requested });
  }
  if (input.simulate) {
    return verifyGoalWorkloop(workloopCtx, {
      workId: input.workId,
      checkId: classified.normalizedCheckId ?? requested,
      checkFailed: input.checkFailed === true,
      infrastructureFailed: input.infrastructureFailed === true,
    });
  }
  try {
    const executed = runControllerCheck(ctx.repository.canonicalRoot, classified.normalizedCheckId!);
    return verifyGoalWorkloop(workloopCtx, {
      workId: input.workId,
      checkId: classified.normalizedCheckId!,
      infrastructureFailed: executed.timedOut === true,
      checkFailed: !executed.ok && !executed.timedOut,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const facade = verifyGoalWorkloop(workloopCtx, {
      workId: input.workId,
      checkId: classified.normalizedCheckId ?? requested,
      infrastructureFailed: true,
    });
    return {
      ...facade,
      warnings: [...facade.warnings, `环境执行检查失败：${message.slice(0, 160)}`],
    };
  }
}

export function finalizeConsoleWork(ctx: ConsoleFacadeContext, workId: string): FacadeResult {
  return finalizeGoalWorkloop(
    {
      workStore: store(ctx),
      handoffStore: store(ctx),
      repoId: ctx.repository.repoId,
      availableChecks: listControllerChecks(ctx.repository.canonicalRoot),
    },
    { workId },
  );
}

export function stopConsoleWork(ctx: ConsoleFacadeContext, workId: string, reason?: string): FacadeResult {
  return stopGoalWorkloop(
    {
      workStore: store(ctx),
      handoffStore: store(ctx),
      repoId: ctx.repository.repoId,
      availableChecks: listControllerChecks(ctx.repository.canonicalRoot),
    },
    { workId, reason },
  );
}

export function delegateConsoleWork(
  ctx: ConsoleFacadeContext,
  input: { workId?: string; target?: 'codex' | 'grok' | 'claude'; objective?: string; available?: boolean },
): FacadeResult {
  const work = input.workId ? getWorkContract(store(ctx), input.workId) : undefined;
  return delegateToCodexCerebellum(
    { repoId: ctx.repository.repoId, workStore: store(ctx), handoffStore: store(ctx) },
    {
      workId: input.workId,
      target: input.target ?? 'codex',
      objective: input.objective || work?.objective || '请协助完成当前任务',
      available: input.available,
      codexAvailable: input.available,
    },
  );
}

export function repairConsole(
  ctx: ConsoleFacadeContext,
  input: {
    operation?: 'diagnose' | 'repair' | 'verify' | 'handoff';
    dryRun?: boolean;
    approvalConfirmed?: boolean;
    destructive?: boolean;
    processKillOrRestart?: boolean;
    workId?: string;
  } = {},
): FacadeResult {
  let maintenanceStatus: {
    readyForExecution?: boolean;
    recommendedActions?: string[];
    candidates?: Array<{ kind?: string; reason?: string; suggestedAction?: string; safe?: boolean }>;
    restartEscalation?: { recommended?: boolean; reason?: string };
    warnings?: string[];
  } | undefined;
  try {
    const status = buildRuntimeMaintenanceStatus(ctx.repository, ctx.controllerHome, { maxCandidates: 20 });
    maintenanceStatus = {
      readyForExecution: status.readyForExecution,
      recommendedActions: status.recommendedActions,
      candidates: status.candidates.map((candidate) => ({
        kind: candidate.kind,
        reason: candidate.reason,
        suggestedAction: candidate.suggestedAction,
        safe: candidate.safe,
      })),
      restartEscalation: {
        recommended: status.restartEscalation.recommended,
        reason: status.restartEscalation.reason,
      },
      warnings: status.warnings,
    };
  } catch {
    maintenanceStatus = {
      readyForExecution: false,
      warnings: ['维护状态读取失败，按环境问题处理，不记作任务验收失败。'],
    };
  }
  const daemon = readControllerDaemonStatus(ctx.controllerHome);
  return runSelfHealingLoop(
    { repoId: ctx.repository.repoId, handoffStore: store(ctx) },
    {
      operation: input.operation ?? 'diagnose',
      dryRun: input.dryRun === undefined ? true : input.dryRun,
      approvalConfirmed: input.approvalConfirmed === true,
      destructive: input.destructive === true,
      processKillOrRestart: input.processKillOrRestart === true,
      workId: input.workId,
      maintenanceStatus,
      diagnostics: {
        controllerDaemonUnhealthy: daemon.status !== 'ready',
      },
    },
  );
}

export function listConsoleHandoffs(ctx: ConsoleFacadeContext, status: 'pending' | 'active' | 'all' = 'pending'): HandoffCardViewModel[] {
  return listHandoffItems({ ...store(ctx), status, limit: 50 }).map(mapHandoffCard);
}

export function getConsoleHandoff(ctx: ConsoleFacadeContext, handoffId: string): HandoffCardViewModel | undefined {
  const item = getHandoffItem(store(ctx), handoffId);
  return item ? mapHandoffCard(item) : undefined;
}

export function ackConsoleHandoff(ctx: ConsoleFacadeContext, handoffId: string) {
  return mapHandoffCard(acknowledgeHandoffItem(store(ctx), handoffId));
}

export function resolveConsoleHandoff(ctx: ConsoleFacadeContext, handoffId: string, decision: string, resolver = 'user') {
  return mapHandoffCard(resolveHandoffItem(store(ctx), handoffId, { decision, resolver }));
}

export function dismissConsoleHandoff(ctx: ConsoleFacadeContext, handoffId: string, decision = 'dismissed', resolver = 'user') {
  return mapHandoffCard(dismissHandoffItem(store(ctx), handoffId, { decision, resolver }));
}

export function getConsoleWork(ctx: ConsoleFacadeContext, workId: string): WorkSummaryViewModel | undefined {
  const work = getWorkContract(store(ctx), workId);
  return work
    ? mapWorkSummary(work, { controllerHome: ctx.controllerHome, repoId: ctx.repository.repoId })
    : undefined;
}

export function listConsoleWork(ctx: ConsoleFacadeContext, status: 'active' | 'all' = 'active'): WorkSummaryViewModel[] {
  return listWorkContracts({ ...store(ctx), status, limit: 50 }).map((work) =>
    mapWorkSummary(work, { controllerHome: ctx.controllerHome, repoId: ctx.repository.repoId }));
}

/** Normalize facade/tool results into GUI-friendly operation feedback. */
export function toConsoleOperationFeedback(result: FacadeResult): {
  phase: string;
  statusLabel: string;
  summary: string;
  terminal: boolean;
  errorClass?: UserFacingErrorClass;
  error?: ConsoleErrorViewModel;
  suggestedNextActions: SuggestedActionViewModel[];
  changedFiles?: ChangedFilesSummaryViewModel;
} {
  const data = (result.data ?? {}) as Record<string, unknown>;
  const status = result.status;
  const phase: UserFacingPhase = status === 'ok'
    ? 'succeeded'
    : status === 'blocked' || status === 'approval_required'
      ? 'needs_attention'
      : status === 'failed'
        ? 'failed'
        : status === 'not_found'
          ? 'failed'
          : 'running';
  const errorClass = status === 'ok'
    ? undefined
    : classifyUserFacingError({
      code: String(data.errorClass ?? data.code ?? ''),
      message: result.summary || String(data.errorMessage ?? ''),
      status,
      infrastructure: status === 'failed' && /环境|infrastructure|daemon|timeout/i.test(result.summary),
      acceptance: /验收|acceptance|valid_fail|未通过/i.test(result.summary),
    });
  const changed = Array.isArray(data.changedFiles)
    ? summarizeChangedFiles(data.changedFiles.map(String))
    : undefined;
  return {
    phase,
    statusLabel: statusLabelForPhase(phase),
    summary: result.summary || (status === 'ok' ? '操作已完成' : '操作未完成'),
    terminal: phase === 'succeeded' || phase === 'failed' || phase === 'needs_attention',
    errorClass,
    error: errorClass ? describeConsoleError(errorClass, result.summary) : undefined,
    suggestedNextActions: mapSuggested(result.suggestedNextActions),
    changedFiles: changed,
  };
}

export function buildConsoleContext(ctx: ConsoleFacadeContext, workId?: string) {
  const checks = listControllerChecks(ctx.repository.canonicalRoot);
  const work = workId ? getWorkContract(store(ctx), workId) : undefined;
  return buildFacadeResult({
    summary: work ? `任务上下文：${work.objective.slice(0, 120)}` : '仓库上下文已就绪',
    data: {
      repositoryName: ctx.repository.displayName,
      checks: checks.map((check) => ({ id: check.id, description: check.description })),
      work: work ? summarizeWorkContract(work) : undefined,
      handoffs: listHandoffItems({ ...store(ctx), status: 'pending', limit: 10 }).map(summarizeHandoffItem),
    },
    suggestedNextActions: work
      ? mapSuggested(work.suggestedNextActions).map((action) => ({
          label: action.label,
          tool: (action.tool as 'rh_work') || 'rh_work',
          operation: action.operation || 'continue',
          payload: action.payload,
          risk: 'readonly' as const,
        }))
      : [{
          label: '开始一个任务',
          tool: 'rh_work' as const,
          operation: 'start',
          risk: 'readonly' as const,
        }],
  });
}

export function normalizeRequestedChecks(ctx: ConsoleFacadeContext, requested: string[]) {
  return normalizeCheckIds(requested, listControllerChecks(ctx.repository.canonicalRoot));
}

/**
 * Interactive safe patch for console/GUI: always sync, returns readable digest.
 */
export function applyConsoleSafePatch(
  ctx: ConsoleFacadeContext,
  input: {
    operations: unknown;
    purpose?: string;
    allowedPaths?: string[];
    sessionId?: string;
  },
): Record<string, unknown> {
  const applied = withControllerLock(
    ctx.controllerHome,
    { scope: 'repository', repoId: ctx.repository.repoId },
    'console:safe_patch_apply',
    () => applySafePatch(ctx.repository, {
      sessionId: input.sessionId,
      purpose: input.purpose ?? 'Console interactive edit',
      operations: input.operations,
      allowedPaths: input.allowedPaths,
      refreshFingerprints: true,
      recoverStaleSession: true,
    }),
    60_000,
  );
  const changedFiles = [...new Set((applied.appliedChunks ?? []).flatMap((chunk) => chunk.paths ?? []))];
  const ok = applied.status === 'applied';
  const firstFailure = applied.failures?.[0];
  const digest = buildSyncOperationDigest({
    ok,
    operation: 'safe_patch_apply',
    summary: ok
      ? `已保存修改（${changedFiles.length} 个文件）。`
      : `修改失败：${firstFailure?.message || '请检查路径或内容后重试'}`,
    changedFiles,
    errorClass: ok ? undefined : classifyUserFacingError({
      code: firstFailure?.code,
      message: firstFailure?.message,
    }),
    errorMessage: firstFailure?.message,
  });
  return {
    ...applied,
    digest,
    summary: digest.summary,
    phase: digest.phase,
    statusLabel: digest.statusLabel,
    terminal: true,
    applyMode: 'sync',
    changedFiles,
    errorClass: digest.errorClass,
    errorMessage: digest.errorMessage,
    suggestedNextActions: digest.suggestedNextActions,
  };
}

/** Keep advanced/debug payload separate from primary console models. */
export async function buildAdvancedDiagnosticsEnvelope(rawSnapshot: unknown, ctx: ConsoleFacadeContext) {
  const readiness = await buildSystemReadiness(ctx);
  const connector = await evaluateConsoleConnectorFreshness(ctx);
  return {
    schemaVersion: 1,
    note: '高级诊断仅供排错。日常任务请使用控制台主流程。',
    readinessSummary: readiness,
    preferredTools: [...EXPECTED_FACADE_TOOLS],
    connectorFreshness: connector,
    raw: rawSnapshot,
  };
}
