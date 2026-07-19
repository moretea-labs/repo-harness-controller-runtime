import { createHash, randomUUID } from 'crypto';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { getAssistantPluginManifest, submitAssistantPluginAction } from '../plugins/store';
import { createExecutionJob } from '../execution/jobs/store';
import { bindAssistantRoutineSchedule } from './schedule-binding';
import type { AssistantIntentResult, AssistantIntentInput, AssistantIntentMode, AssistantIntentSource, AssistantPlanStepInput, AssistantPlanStepResult, AssistantRoutine, AssistantRoutineDraft } from './types';
import { addAssistantInboxItem, createAssistantRoutine, getAssistantRoutine, touchAssistantRoutineRun } from './store';
import { defaultRoutineAllowedActions, defaultRoutineForbiddenActions, evaluateAssistantActionPolicy } from './policy';

function now(): string { return new Date().toISOString(); }

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeMode(value: unknown): AssistantIntentMode {
  return value === 'plan_only' || value === 'execute' || value === 'plan_then_execute' ? value : 'plan_then_execute';
}

function normalizeSource(value: unknown): AssistantIntentSource {
  return value === 'mcp' || value === 'local-ui' || value === 'mobile' || value === 'system' ? value : 'chatgpt';
}

function requestId(input: AssistantIntentInput): string {
  const explicit = stringValue(input.requestId);
  if (explicit) return explicit;
  const text = stringValue(input.utterance) ?? JSON.stringify(input.plan ?? input.routine ?? {});
  const digest = createHash('sha256').update(`${text}:${Date.now()}:${randomUUID()}`).digest('hex').slice(0, 16);
  return `assistant-intent-${digest}`;
}

function sourceToSurface(source: AssistantIntentSource): 'chatgpt-action' | 'mcp' | 'local-ui' | 'mobile-intent' | 'system' {
  if (source === 'mcp') return 'mcp';
  if (source === 'local-ui') return 'local-ui';
  if (source === 'mobile') return 'mobile-intent';
  if (source === 'system') return 'system';
  return 'chatgpt-action';
}

function planStepId(index: number, step: AssistantPlanStepInput): string {
  return step.stepId?.trim() || `step-${index + 1}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function containsAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function inferRoutineDraft(input: AssistantIntentInput): AssistantRoutineDraft | undefined {
  const text = stringValue(input.utterance) ?? stringValue(input.routine?.naturalLanguageGoal) ?? '';
  const lower = text.toLowerCase();
  const wantsRoutine = containsAny(lower, ['每天', '每日', '每周', '以后', '定期', 'daily', 'every day', 'weekly', 'routine']);
  if (!wantsRoutine && !input.routine) return undefined;
  const mentionsMail = containsAny(lower, ['邮件', '邮箱', 'gmail', 'email', 'mail']);
  const mentionsWork = containsAny(lower, ['工作', 'jira', 'pr', 'api', 'ba', 'uat', 'sit', 'kafka']);
  const goal = firstString(input.routine?.naturalLanguageGoal, input.utterance) ?? '按自然语言目标执行个人助理 routine。';
  const scheduleText = firstString(input.routine?.scheduleText, input.context?.scheduleText, input.context?.schedule) ?? (containsAny(lower, ['每周', 'weekly']) ? '每周' : '每天 09:00');
  const dataSources = Array.isArray(input.routine?.dataSources) && input.routine.dataSources.length > 0
    ? input.routine.dataSources.map(String)
    : mentionsMail
      ? ['gmail', ...(mentionsWork ? ['calendar', 'tasks'] : [])]
      : ['gmail', 'calendar', 'tasks'];
  const name = firstString(input.routine?.name) ?? (mentionsMail ? '每日邮件整理' : '个人助理 Routine');
  return {
    name,
    naturalLanguageGoal: goal,
    scheduleText,
    timezone: firstString(input.routine?.timezone, input.timezone),
    dataSources: [...new Set(dataSources)],
    output: input.routine?.output === 'gmail_draft' || input.routine?.output === 'none' ? input.routine.output : 'assistant_inbox',
    allowedActions: Array.isArray(input.routine?.allowedActions) && input.routine.allowedActions.length > 0
      ? input.routine.allowedActions.map(String)
      : defaultRoutineAllowedActions(),
    forbiddenActions: Array.isArray(input.routine?.forbiddenActions) && input.routine.forbiddenActions.length > 0
      ? input.routine.forbiddenActions.map(String)
      : defaultRoutineForbiddenActions(),
  };
}

function dueFromContext(input: AssistantIntentInput): string | undefined {
  const explicit = firstString(input.context?.due, input.context?.dueAt, input.context?.datetime, input.context?.time);
  if (explicit) return explicit;
  const utterance = stringValue(input.utterance) ?? '';
  const nowDate = new Date();
  const tomorrow = /明天|tomorrow/i.test(utterance);
  const hourMatch = utterance.match(/(?:上午|早上|morning|at)?\s*(\d{1,2})\s*(?:点|:00|am|pm)?/i);
  if (!tomorrow && !hourMatch) return undefined;
  const due = new Date(nowDate);
  if (tomorrow) due.setDate(due.getDate() + 1);
  if (hourMatch) {
    let hour = Number(hourMatch[1]);
    if (/下午|晚上|pm/i.test(utterance) && hour < 12) hour += 12;
    due.setHours(hour, 0, 0, 0);
  }
  return due.toISOString();
}

function reminderTitle(input: AssistantIntentInput): string | undefined {
  const explicit = firstString(input.context?.title, input.context?.taskTitle, input.context?.reminderTitle);
  if (explicit) return explicit;
  const utterance = stringValue(input.utterance) ?? '';
  if (!containsAny(utterance, ['提醒', 'remind', 'task', 'todo'])) return undefined;
  return utterance
    .replace(/^(请|帮我|麻烦)?/g, '')
    .replace(/(明天|今天|后天|上午|下午|晚上|早上|中午|tomorrow|today|at|am|pm|\d{1,2}\s*点|\d{1,2}:\d{2})/ig, '')
    .replace(/(提醒我|提醒|remind me to|remind me|create a reminder to|create reminder)/ig, '')
    .replace(/[，。,.;；]+/g, ' ')
    .trim()
    .slice(0, 120) || undefined;
}

function inferReminderStep(input: AssistantIntentInput): AssistantPlanStepInput | undefined {
  const title = reminderTitle(input);
  if (!title) return undefined;
  return {
    pluginId: 'google_tasks',
    actionId: 'create_task',
    arguments: {
      title,
      ...(firstString(input.context?.notes) ? { notes: firstString(input.context?.notes) } : {}),
      ...(dueFromContext(input) ? { due: dueFromContext(input) } : {}),
    },
  };
}

function inferMailSummaryStep(input: AssistantIntentInput): AssistantPlanStepInput | undefined {
  const utterance = stringValue(input.utterance) ?? '';
  if (!containsAny(utterance, ['整理邮件', '总结邮件', '邮件摘要', 'email summary', 'summarize email', 'summarize mail'])) return undefined;
  if (containsAny(utterance, ['每天', '每日', '以后', 'daily', 'every day', 'routine'])) return undefined;
  return {
    pluginId: 'gmail',
    actionId: 'list_messages',
    arguments: {
      query: firstString(input.context?.query) ?? 'newer_than:1d',
      max_results: typeof input.context?.max_results === 'number' ? input.context.max_results : 20,
    },
  };
}

function inferGmailReadStep(input: AssistantIntentInput): AssistantPlanStepInput | undefined {
  const utterance = stringValue(input.utterance) ?? '';
  if (!containsAny(utterance, ['gmail', '邮件', '邮箱', 'email', 'mail'])) return undefined;
  if (containsAny(utterance, ['每天', '每日', '以后', 'daily', 'every day', 'routine'])) return undefined;
  if (!containsAny(utterance, ['读取', '查看', '搜索', '测试', '模拟', 'list', 'read', 'search', 'test', 'simulate', '整理', '总结'])) return undefined;
  return {
    pluginId: 'gmail',
    actionId: 'list_messages',
    arguments: {
      query: firstString(input.context?.query) ?? (containsAny(utterance, ['最近一周', '7天', '7 天', 'week']) ? 'newer_than:7d' : 'newer_than:1d'),
      max_results: typeof input.context?.max_results === 'number' ? input.context.max_results : 10,
    },
  };
}

function intentNameForStep(step: AssistantPlanStepInput | undefined): string {
  if (!step) return 'execute_plan';
  if (step.pluginId === 'google_tasks' && step.actionId === 'create_task') return 'create_reminder';
  if (step.pluginId === 'gmail' && step.actionId === 'list_messages') return 'read_gmail';
  return `${step.pluginId}.${step.actionId}`;
}

function initialResult(input: AssistantIntentInput, source: AssistantIntentSource, mode: AssistantIntentMode, id: string): AssistantIntentResult {
  return {
    schemaVersion: 1,
    accepted: false,
    mode,
    source,
    requestId: id,
    understoodIntent: 'unknown',
    displayTitle: '需要更多信息',
    displayText: '我还没有足够信息把这句话转换成安全的本地动作。',
    requiresConfirmation: false,
    plan: [],
    clarifyingQuestions: stringValue(input.utterance) ? [] : ['请提供自然语言请求 utterance，或直接提供结构化 plan。'],
  };
}

function submitPlanSteps(
  controllerHome: string,
  repository: RepositoryRecord,
  input: AssistantIntentInput,
  steps: AssistantPlanStepInput[],
  source: AssistantIntentSource,
  id: string,
  options: { automatedRoutine?: boolean } = {},
): AssistantPlanStepResult[] {
  return steps.map((step, index) => {
    const stepId = planStepId(index, step);
    try {
      const manifest = getAssistantPluginManifest(controllerHome, repository, step.pluginId);
      const action = manifest.actions.find((entry) => entry.actionId === step.actionId);
      if (!action) throw new Error(`PLUGIN_ACTION_NOT_FOUND: ${step.pluginId}/${step.actionId}`);
      const args = objectValue(step.arguments);
      const policy = evaluateAssistantActionPolicy(step.pluginId, action, args, options);
      if (policy.decision !== 'allow') {
        return {
          stepId,
          pluginId: step.pluginId,
          actionId: step.actionId,
          status: 'blocked',
          risk: action.risk,
          decision: policy.decision,
          reason: policy.reason,
          requiredConfirmationText: policy.requiredConfirmationText,
        } satisfies AssistantPlanStepResult;
      }
      const submitted = submitAssistantPluginAction(controllerHome, repository, {
        pluginId: step.pluginId,
        actionId: step.actionId,
        requestId: step.requestId?.trim() || `${id}:${stepId}`,
        args,
        confirmAuthorization: step.confirmAuthorization === true || policy.autoConfirmAuthorization,
        confirmationText: step.confirmationText,
        origin: { surface: sourceToSurface(source), actor: source, correlationId: id },
      });
      return {
        stepId,
        pluginId: step.pluginId,
        actionId: step.actionId,
        status: 'submitted',
        risk: submitted.action.risk,
        decision: policy.decision,
        reason: policy.reason,
        job: submitted.job,
      } satisfies AssistantPlanStepResult;
    } catch (error) {
      return {
        stepId,
        pluginId: step.pluginId,
        actionId: step.actionId,
        status: 'blocked',
        risk: 'unknown',
        decision: 'reject',
        reason: error instanceof Error ? error.message : String(error),
      } satisfies AssistantPlanStepResult;
    }
  });
}

export function submitAssistantIntent(
  controllerHome: string,
  repository: RepositoryRecord,
  input: AssistantIntentInput,
): AssistantIntentResult {
  const source = normalizeSource(input.source);
  const mode = normalizeMode(input.mode);
  const id = requestId(input);
  const base = initialResult(input, source, mode, id);
  const routineDraft = inferRoutineDraft(input);
  if (routineDraft) {
    if (mode === 'plan_only' || input.confirmRoutine !== true) {
      return {
        ...base,
        accepted: true,
        understoodIntent: 'create_routine',
        displayTitle: '准备创建个人助理 Routine',
        displayText: `我理解你想保存「${routineDraft.name}」：${routineDraft.naturalLanguageGoal}`,
        requiresConfirmation: true,
        confirmationSummary: `保存后将按「${routineDraft.scheduleText}」触发，默认输出到 Assistant Inbox，不会自动发送或删除邮件。`,
        routineDraft,
      };
    }
    const routine = createAssistantRoutine(repository.canonicalRoot, routineDraft);
    const binding = bindAssistantRoutineSchedule(controllerHome, repository, routine);
    const inboxItem = addAssistantInboxItem(repository.canonicalRoot, {
      kind: 'system_note',
      title: `已创建 Routine：${routine.name}`,
      summary: `${routine.scheduleText} · ${routine.naturalLanguageGoal}`,
      source,
      relatedRoutineId: routine.routineId,
      relatedRequestId: id,
      jobIds: [],
      recommendations: ['你可以在 ChatGPT 里说“暂停这个 routine”或调用 /api/assistant/routines/:id/pause。'],
      data: { routine, binding },
    });
    return {
      ...base,
      accepted: true,
      understoodIntent: 'create_routine',
      displayTitle: 'Routine 已保存',
      displayText: `已保存「${routine.name}」，并绑定到持久化 Schedule：${binding.normalizedSchedule}。`,
      requiresConfirmation: false,
      routine,
      inboxItem,
    };
  }

  const inferredStep = inferReminderStep(input) ?? inferGmailReadStep(input) ?? inferMailSummaryStep(input);
  const steps = input.plan && input.plan.length > 0 ? input.plan : inferredStep ? [inferredStep] : [];
  if (steps.length === 0) return base;
  if (mode === 'plan_only') {
    const plan = steps.map((step, index) => ({
      stepId: planStepId(index, step),
      pluginId: step.pluginId,
      actionId: step.actionId,
      status: 'planned' as const,
      risk: 'unknown' as const,
      decision: 'allow' as const,
      reason: 'Plan-only mode returned the proposed action without submitting an execution job.',
    }));
    return {
      ...base,
      accepted: true,
      understoodIntent: intentNameForStep(inferredStep),
      displayTitle: '已生成执行计划',
      displayText: `已生成 ${plan.length} 个本地执行步骤，尚未提交。`,
      requiresConfirmation: false,
      plan,
    };
  }
  const plan = submitPlanSteps(controllerHome, repository, input, steps, source, id);
  const submitted = plan.filter((step) => step.status === 'submitted');
  const blocked = plan.filter((step) => step.status === 'blocked');
  const inboxItem = addAssistantInboxItem(repository.canonicalRoot, {
    kind: blocked.length > 0 ? 'approval_request' : 'intent_result',
    title: blocked.length > 0 ? '个人助理请求需要确认' : '个人助理请求已提交',
    summary: blocked.length > 0
      ? `${blocked.length} 个步骤被策略拦截，需要人工确认。`
      : `已提交 ${submitted.length} 个执行步骤。`,
    source,
    relatedRequestId: id,
    jobIds: submitted.flatMap((step) => step.job?.jobId ? [step.job.jobId] : []),
    recommendations: blocked.map((step) => `${step.pluginId}.${step.actionId}: ${step.reason}`).slice(0, 5),
    data: { plan },
  });
  return {
    ...base,
    accepted: submitted.length > 0 && blocked.length === 0,
    understoodIntent: inferredStep ? (inferredStep.actionId === 'create_task' ? 'create_reminder' : 'summarize_email') : 'execute_plan',
    displayTitle: blocked.length > 0 ? '需要人工确认' : '请求已提交',
    displayText: blocked.length > 0
      ? `有 ${blocked.length} 个步骤需要确认；已提交 ${submitted.length} 个安全步骤。`
      : `已提交 ${submitted.length} 个步骤到本地执行队列。`,
    requiresConfirmation: blocked.length > 0,
    confirmationSummary: blocked.map((step) => `${step.pluginId}.${step.actionId}: ${step.reason}`).join('\n') || undefined,
    plan,
    inboxItem,
  };
}

export function runAssistantRoutineNow(
  controllerHome: string,
  repository: RepositoryRecord,
  routineId: string,
): AssistantIntentResult {
  const routine = getAssistantRoutine(repository.canonicalRoot, routineId);
  if (routine.status !== 'enabled') throw new Error(`ASSISTANT_ROUTINE_NOT_ENABLED: ${routineId}`);
  const requestId = `routine-run-${routine.routineId}-${Date.now()}`;
  const created = createExecutionJob(controllerHome, {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    type: 'mcp-tool',
    requestId,
    semanticKey: `assistant-routine:${routine.routineId}:${requestId}`,
    priority: 'P2',
    origin: { surface: 'assistant-routine', actor: routine.routineId, correlationId: requestId },
    payload: {
      operation: 'assistant_routine_execute',
      target: 'runtime',
      arguments: { routineId: routine.routineId },
      timeoutMs: 30 * 60_000,
    },
    resourceClaims: [{ resourceKey: `assistant-routine:${repository.repoId}:${routine.routineId}`, mode: 'exclusive' }],
    timeoutMs: 30 * 60_000,
    maxAttempts: 1,
  });
  const touched = touchAssistantRoutineRun(repository.canonicalRoot, routineId);
  const plan: AssistantPlanStepResult[] = [{
    stepId: 'routine-runtime',
    pluginId: 'assistant',
    actionId: 'assistant_routine_execute',
    status: 'submitted',
    risk: 'readonly',
    decision: 'allow',
    reason: 'A durable read-only Routine Runtime Job was queued.',
    job: created.job,
  }];
  const inboxItem = addAssistantInboxItem(repository.canonicalRoot, {
    kind: 'routine_result',
    title: `Routine 已排队：${routine.name}`,
    summary: '已提交持久化 Routine Runtime Job；完成后会生成最终邮件报告。',
    body: routine.naturalLanguageGoal,
    source: 'routine',
    relatedRoutineId: routine.routineId,
    relatedRequestId: requestId,
    jobIds: [created.job.jobId],
    recommendations: ['等待最终 Routine 报告；发送邮件和移入垃圾箱仍需单独确认。'],
    data: { routine: touched, jobId: created.job.jobId },
  });
  return {
    schemaVersion: 1,
    accepted: true,
    mode: 'execute',
    source: 'system',
    requestId,
    understoodIntent: 'run_routine',
    displayTitle: `Routine 已排队：${routine.name}`,
    displayText: `已为「${routine.name}」提交持久化执行 Job ${created.job.jobId}。`,
    requiresConfirmation: false,
    plan,
    routine: touched,
    inboxItem,
    clarifyingQuestions: [],
  };
}

export function assistantRoutineDraftFromInput(input: AssistantIntentInput): AssistantRoutineDraft | undefined {
  return inferRoutineDraft(input);
}
