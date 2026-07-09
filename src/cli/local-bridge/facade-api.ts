import type { RepositoryRecord } from '../repositories/types';
import { listControllerChecks, runControllerCheck } from '../controller/check-runner';
import { controllerExpectedToolNames } from '../mcp/tools';
import { runtimePolicy } from '../mcp/multi-repository';
import { readControllerDaemonStatus } from '../../runtime/control-plane/daemon-client';
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
import type {
  CommandCenterViewModel,
  ConnectorFreshnessViewModel,
  HandoffCardViewModel,
  ModePreviewViewModel,
  PlainStatusTone,
  RepositoryCardViewModel,
  SuggestedActionViewModel,
  SystemReadinessViewModel,
  VerificationViewModel,
  WorkSummaryViewModel,
} from './console-view-models';

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

function workStatusLabel(status: WorkContract['status']): { label: string; tone: PlainStatusTone } {
  switch (status) {
    case 'running': return { label: '进行中', tone: 'blue' };
    case 'pending': return { label: '待开始', tone: 'gray' };
    case 'blocked': return { label: '已阻塞', tone: 'red' };
    case 'waiting_for_review': return { label: '需要你审阅', tone: 'amber' };
    case 'succeeded': return { label: '已完成', tone: 'green' };
    case 'failed': return { label: '未通过验收', tone: 'red' };
    case 'cancelled': return { label: '已停止', tone: 'gray' };
    default: return { label: String(status), tone: 'gray' };
  }
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

export function mapWorkSummary(work: WorkContract): WorkSummaryViewModel {
  const status = workStatusLabel(work.status);
  const mode = plainMode(work.mode === 'direct_control' || work.mode === 'handoff_only' ? work.mode : 'goal_workloop');
  const verification = latestVerification(work);
  const nextAction = work.suggestedNextActions[0]?.label
    ?? (work.status === 'waiting_for_review' ? '请审阅后继续或收尾'
      : work.status === 'running' ? '继续或运行检查'
        : work.status === 'succeeded' ? '任务已完成'
          : work.status === 'failed' ? '查看失败原因并决定是否重试'
            : '查看任务状态');
  return {
    id: work.workId,
    title: work.objective.slice(0, 160) || '未命名任务',
    modeLabel: mode.label,
    mode: mode.mode,
    statusLabel: status.label,
    tone: status.tone,
    nextAction,
    progressSteps: progressSteps(work),
    latestVerification: verification,
    acceptanceCriteria: work.acceptanceCriteria.slice(0, 8),
    evidenceLabels: work.evidenceRefs.slice(0, 6).map((entry) => entry.title || entry.summary || '证据'),
    delegateSummary: work.workerRef
      ? `已委派小助手（${work.workerRef.split(':')[0] ?? 'worker'}），等待 ChatGPT 审阅后才能收尾。`
      : undefined,
    suggestedActions: mapSuggested(work.suggestedNextActions),
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
  return {
    id: repository.repoId,
    name: repository.displayName || repository.repoId,
    path: displayPath(repository.canonicalRoot),
    statusLabel: current ? '当前' : repository.enabled === false ? '已停用' : '可用',
    tone: current ? 'green' : repository.enabled === false ? 'gray' : 'blue',
    current,
    advanced: {
      repoId: repository.repoId,
      remote: repository.remoteUrl,
      defaultBranch: repository.defaultBranch,
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

export async function buildCommandCenter(
  ctx: ConsoleFacadeContext,
  repositories: RepositoryCardViewModel[],
): Promise<CommandCenterViewModel> {
  const readiness = await buildSystemReadiness(ctx);
  const currentRepository = repositories.find((entry) => entry.current) ?? mapRepositoryCard(ctx.repository, true);
  const activeWork = listWorkContracts({ ...store(ctx), status: 'active', limit: 20 }).map(mapWorkSummary);
  const allRecent = listWorkContracts({ ...store(ctx), status: 'all', limit: 12 }).map(mapWorkSummary);
  const handoffs = listHandoffItems({ ...store(ctx), status: 'pending', limit: 20 }).map(mapHandoffCard);
  const banner = readiness.connectorFreshness?.severity === 'warning' || readiness.connectorFreshness?.severity === 'error'
    ? readiness.connectorFreshness.summary
    : undefined;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readiness,
    currentRepository,
    repositories,
    currentWork: activeWork[0],
    recentWork: allRecent,
    handoffs,
    modePreviewDefault: plainMode('direct_control'),
    // Only surface confirmed warnings — never "maybe missing" when ChatGPT snapshot is unobserved.
    warnings: banner ? [banner] : [],
  };
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
  return work ? mapWorkSummary(work) : undefined;
}

export function listConsoleWork(ctx: ConsoleFacadeContext, status: 'active' | 'all' = 'active'): WorkSummaryViewModel[] {
  return listWorkContracts({ ...store(ctx), status, limit: 50 }).map(mapWorkSummary);
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

