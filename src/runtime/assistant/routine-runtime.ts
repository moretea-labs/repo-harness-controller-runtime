import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import type { ExecutionJobOrigin } from '../execution/jobs/types';
import { executeAssistantPluginAction } from '../plugins/store';
import { isAssistantPluginError } from '../plugins/errors';
import {
  createAssistantActionProposals,
  type AssistantActionProposal,
  type AssistantActionProposalInput,
} from './action-proposals';
import { addAssistantInboxItem, getAssistantRoutine, touchAssistantRoutineRun } from './store';

export type AssistantRoutineRunStatus = 'collecting' | 'completed' | 'failed' | 'auth_required';

export interface AssistantRoutineRun {
  schemaVersion: 1;
  runId: string;
  routineId: string;
  requestId: string;
  occurrenceId?: string;
  status: AssistantRoutineRunStatus;
  windowStart: string;
  windowEnd: string;
  collectedItems: number;
  processedItems: number;
  proposedActions: number;
  summary?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

interface GmailRoutineCursor {
  schemaVersion: 1;
  routineId: string;
  lastSuccessfulAt?: string;
  historyId?: string;
  continuation?: { mode: 'history' | 'query'; pageToken: string };
  processedMessageIds: string[];
  updatedAt: string;
}

interface GmailMessageSummary {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  date?: string;
  snippet: string;
  bodyPreview?: string;
  labelIds: string[];
}

function now(): string { return new Date().toISOString(); }
function assistantRoot(repoRoot: string): string { return join(repoRoot, '.repo-harness', 'assistant'); }
function runsPath(repoRoot: string): string { return join(assistantRoot(repoRoot), 'routine-runs.json'); }
function cursorsPath(repoRoot: string): string { return join(assistantRoot(repoRoot), 'gmail-cursors.json'); }

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function saveRun(repoRoot: string, run: AssistantRoutineRun): AssistantRoutineRun {
  const current = readJson<{ schemaVersion: 1; updatedAt: string; runs: AssistantRoutineRun[] }>(runsPath(repoRoot), {
    schemaVersion: 1,
    updatedAt: now(),
    runs: [],
  });
  current.runs = [run, ...current.runs.filter((entry) => entry.runId !== run.runId)].slice(0, 500);
  current.updatedAt = now();
  writeJson(runsPath(repoRoot), current);
  return run;
}

function readCursor(repoRoot: string, routineId: string): GmailRoutineCursor {
  const current = readJson<{ schemaVersion: 1; updatedAt: string; cursors: GmailRoutineCursor[] }>(cursorsPath(repoRoot), {
    schemaVersion: 1,
    updatedAt: now(),
    cursors: [],
  });
  return current.cursors.find((entry) => entry.routineId === routineId) ?? {
    schemaVersion: 1,
    routineId,
    processedMessageIds: [],
    updatedAt: now(),
  };
}

function saveCursor(repoRoot: string, cursor: GmailRoutineCursor): void {
  const current = readJson<{ schemaVersion: 1; updatedAt: string; cursors: GmailRoutineCursor[] }>(cursorsPath(repoRoot), {
    schemaVersion: 1,
    updatedAt: now(),
    cursors: [],
  });
  current.cursors = [{ ...cursor, updatedAt: now() }, ...current.cursors.filter((entry) => entry.routineId !== cursor.routineId)].slice(0, 200);
  current.updatedAt = now();
  writeJson(cursorsPath(repoRoot), current);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function decodeBase64Url(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}

function bodyText(payload: Record<string, unknown>, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const body = recordValue(payload.body);
  const direct = decodeBase64Url(stringValue(body.data));
  if (direct) return direct;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const preferred = parts
    .map((entry) => recordValue(entry))
    .sort((left, right) => String(left.mimeType) === 'text/plain' ? -1 : String(right.mimeType) === 'text/plain' ? 1 : 0);
  for (const part of preferred) {
    const decoded = bodyText(part, depth + 1);
    if (decoded) return decoded;
  }
  return undefined;
}

function summarizeMessage(raw: Record<string, unknown>): GmailMessageSummary {
  const payload = recordValue(raw.payload);
  const headers = Array.isArray(payload.headers) ? payload.headers.map(recordValue) : [];
  const header = (name: string): string | undefined => stringValue(headers.find((entry) => String(entry.name).toLowerCase() === name.toLowerCase())?.value);
  const decoded = bodyText(payload)?.replace(/\s+/g, ' ').trim();
  return {
    id: String(raw.id ?? ''),
    threadId: stringValue(raw.threadId),
    from: header('From') ?? 'unknown sender',
    subject: header('Subject') ?? '(no subject)',
    date: header('Date'),
    snippet: String(raw.snippet ?? '').replace(/\s+/g, ' ').trim(),
    bodyPreview: decoded?.slice(0, 1_500),
    labelIds: stringArray(raw.labelIds),
  };
}

function senderAddress(value: string): string | undefined {
  return value.match(/<([^>]+@[^>]+)>/)?.[1] ?? value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function proposalsFor(messages: GmailMessageSummary[]): AssistantActionProposalInput[] {
  const proposals: AssistantActionProposalInput[] = [];
  for (const message of messages) {
    const text = `${message.subject} ${message.snippet} ${message.bodyPreview ?? ''}`.toLowerCase();
    if (/(please reply|reply requested|请回复|需要回复|your response)/i.test(text)) {
      const to = senderAddress(message.from);
      proposals.push({
        pluginId: 'gmail', actionId: 'create_draft', evidenceMessageIds: [message.id],
        reason: `Prepare a reviewable reply draft for “${message.subject}”.`, confidence: 0.75,
        executable: Boolean(to),
        arguments: to ? { to: [to], subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`, body_text: '[Draft response pending review]' } : {},
      });
    }
    if (/(action required|todo|deadline|due date|需要处理|截止|待办)/i.test(text)) {
      proposals.push({
        pluginId: 'google_tasks', actionId: 'create_task', evidenceMessageIds: [message.id],
        reason: `Create a task from “${message.subject}”.`, confidence: 0.8,
        arguments: { title: message.subject, notes: `${message.from}\n${message.snippet}`.slice(0, 2_000) },
      });
    }
    if (/(newsletter|digest|marketing|unsubscribe|推广|营销|周报)/i.test(text)) {
      proposals.push({
        pluginId: 'gmail', actionId: 'archive_message', evidenceMessageIds: [message.id],
        reason: `Archive candidate: “${message.subject}”.`, confidence: 0.7,
        arguments: { message_id: message.id },
      });
    }
  }
  return proposals.slice(0, 50);
}

function renderReport(messages: GmailMessageSummary[], proposals: AssistantActionProposalInput[], windowStart: string, windowEnd: string): string {
  const important = messages.filter((message) => /(security|alert|billing|invoice|jira|github|production|incident|安全|账单|故障|告警)/i.test(`${message.subject} ${message.snippet}`));
  const lines = [
    `窗口：${windowStart} — ${windowEnd}`,
    `读取邮件：${messages.length} 封；重要候选：${important.length} 封；行动建议：${proposals.length} 项。`,
    '',
    '重要邮件候选：',
    ...(important.length > 0
      ? important.slice(0, 15).map((message) => `- ${message.subject} — ${message.from}`)
      : ['- 未发现明确的重要邮件候选。']),
    '',
    '最近邮件：',
    ...messages.slice(0, 20).map((message) => `- ${message.subject} — ${message.from}${message.snippet ? `：${message.snippet.slice(0, 160)}` : ''}`),
    '',
    '行动建议（仅提议，不会自动发送或删除）：',
    ...(proposals.length > 0 ? proposals.slice(0, 20).map((proposal) => `- ${proposal.reason}`) : ['- 暂无。']),
  ];
  return lines.join('\n');
}

async function gmailAction(
  controllerHome: string,
  repository: RepositoryRecord,
  origin: ExecutionJobOrigin,
  requestId: string,
  actionId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const executed = await executeAssistantPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    pluginId: 'gmail',
    actionId,
    requestId,
    args,
    origin,
  });
  return recordValue(executed.result);
}

export async function executeAssistantRoutineRuntime(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  routineId: string;
  requestId: string;
  origin: ExecutionJobOrigin;
  occurrenceId?: string;
}): Promise<{ run: AssistantRoutineRun; messages: GmailMessageSummary[]; proposals: AssistantActionProposal[] }> {
  const routine = getAssistantRoutine(input.repository.canonicalRoot, input.routineId);
  if (routine.status !== 'enabled') throw new Error(`ASSISTANT_ROUTINE_NOT_ENABLED: ${routine.routineId}`);
  const cursor = readCursor(input.repository.canonicalRoot, routine.routineId);
  const windowEnd = now();
  const fallbackStart = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const windowStart = cursor.lastSuccessfulAt ?? fallbackStart;
  const runId = input.occurrenceId ? `routine-run-${input.occurrenceId}` : `routine-run-${routine.routineId}-${Date.now()}`;
  let run = saveRun(input.repository.canonicalRoot, {
    schemaVersion: 1,
    runId,
    routineId: routine.routineId,
    requestId: input.requestId,
    occurrenceId: input.occurrenceId,
    status: 'collecting',
    windowStart,
    windowEnd,
    collectedItems: 0,
    processedItems: 0,
    proposedActions: 0,
    createdAt: now(),
  });
  try {
    if (!routine.dataSources.includes('gmail')) {
      throw new Error('ASSISTANT_ROUTINE_GMAIL_REQUIRED: this runtime currently finalizes Gmail-backed routines');
    }
    const profile = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:profile`, 'get_profile', {});
    const known = new Set(cursor.processedMessageIds);
    const messageIds: string[] = [];
    const startingContinuation = cursor.continuation;
    let nextContinuation: GmailRoutineCursor['continuation'];
    let historyFallback = !cursor.historyId;
    let historyInvalid = false;
    if (cursor.historyId) {
      try {
        let historyPageToken = startingContinuation?.mode === 'history' ? startingContinuation.pageToken : undefined;
        for (let page = 0; page < 5 && messageIds.length < 100; page += 1) {
          const history = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:history:${page}`, 'list_history', {
            start_history_id: cursor.historyId, max_results: 100, label_id: 'INBOX', history_type: 'messageAdded',
            ...(historyPageToken ? { page_token: historyPageToken } : {}),
          });
          for (const entry of Array.isArray(history.history) ? history.history.map(recordValue) : []) {
            for (const added of Array.isArray(entry.messagesAdded) ? entry.messagesAdded.map(recordValue) : []) {
              const id = stringValue(recordValue(added.message).id);
              if (id && !known.has(id) && !messageIds.includes(id)) messageIds.push(id);
            }
          }
          historyPageToken = stringValue(history.nextPageToken);
          if (!historyPageToken) break;
        }
        if (historyPageToken) nextContinuation = { mode: 'history', pageToken: historyPageToken };
      } catch (error) {
        const status = isAssistantPluginError(error) ? Number(error.details?.status) : undefined;
        if (status !== 404) throw error;
        historyFallback = true;
        historyInvalid = true;
        nextContinuation = undefined;
      }
    }
    if (historyFallback) {
      const overlapStart = Math.max(0, Date.parse(windowStart) - 5 * 60_000);
      const query = `in:inbox -in:spam -in:trash after:${Math.floor(overlapStart / 1000)}`;
      let pageToken = startingContinuation?.mode === 'query' ? startingContinuation.pageToken : undefined;
      for (let page = 0; page < 5 && messageIds.length < 100; page += 1) {
        const listed = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:list:${page}`, 'list_messages', {
          query, max_results: 25, ...(pageToken ? { page_token: pageToken } : {}),
        });
        for (const message of Array.isArray(listed.messages) ? listed.messages.map(recordValue) : []) {
          const id = stringValue(message.id);
          if (id && !known.has(id) && !messageIds.includes(id)) messageIds.push(id);
        }
        pageToken = stringValue(listed.nextPageToken);
        if (!pageToken) break;
      }
      nextContinuation = pageToken ? { mode: 'query', pageToken } : undefined;
    }
    const messages: GmailMessageSummary[] = [];
    for (const messageId of messageIds.slice(0, 50)) {
      const fetched = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:message:${messageId}`, 'get_message', {
        message_id: messageId,
        format: 'full',
      });
      const raw = recordValue(fetched.message && typeof fetched.message === 'object' ? fetched.message : fetched);
      messages.push(summarizeMessage(raw));
    }
    const proposalInputs = proposalsFor(messages);
    const proposals = createAssistantActionProposals(input.controllerHome, input.repository, { routineId: routine.routineId, runId, proposals: proposalInputs });
    const hydrationTruncated = messageIds.length > messages.length;
    const paginationIncomplete = Boolean(nextContinuation);
    const truncated = hydrationTruncated || paginationIncomplete;
    const savedContinuation = truncated
      ? hydrationTruncated ? startingContinuation : nextContinuation
      : undefined;
    const report = renderReport(messages, proposals, windowStart, windowEnd);
    run = saveRun(input.repository.canonicalRoot, {
      ...run,
      status: 'completed',
      collectedItems: messageIds.length,
      processedItems: messages.length,
      proposedActions: proposals.length,
      summary: report,
      completedAt: now(),
    });
    touchAssistantRoutineRun(input.repository.canonicalRoot, routine.routineId);
    addAssistantInboxItem(input.repository.canonicalRoot, {
      kind: 'routine_result',
      title: `Routine 已完成：${routine.name}`,
      summary: `读取 ${messages.length} 封新邮件，生成 ${proposals.length} 项只读行动建议。`,
      body: report,
      source: 'routine',
      relatedRoutineId: routine.routineId,
      relatedRequestId: input.requestId,
      jobIds: [],
      recommendations: [
        ...(truncated ? ['本次达到正文读取上限，下一次将从相同时间窗口继续处理剩余邮件。'] : []),
        '发送邮件和移入垃圾箱仍需单独明确确认。',
        '可基于行动建议创建草稿、任务或归档审批。',
      ],
      data: { run, messages, proposals, truncated },
    });
    saveCursor(input.repository.canonicalRoot, {
      schemaVersion: 1,
      routineId: routine.routineId,
      lastSuccessfulAt: truncated ? windowStart : windowEnd,
      historyId: truncated ? historyInvalid ? undefined : cursor.historyId : stringValue(profile.historyId) ?? cursor.historyId,
      continuation: savedContinuation,
      processedMessageIds: [...messages.map((message) => message.id), ...cursor.processedMessageIds].slice(0, 1_000),
      updatedAt: now(),
    });
    return { run, messages, proposals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const authRequired = /PLUGIN_AUTH|UNAUTHENTICATED|invalid credentials/i.test(message);
    run = saveRun(input.repository.canonicalRoot, {
      ...run,
      status: authRequired ? 'auth_required' : 'failed',
      error: message,
      completedAt: now(),
    });
    addAssistantInboxItem(input.repository.canonicalRoot, {
      kind: 'system_note',
      title: authRequired ? `Routine 需要重新授权：${routine.name}` : `Routine 执行失败：${routine.name}`,
      summary: message,
      source: 'routine',
      relatedRoutineId: routine.routineId,
      relatedRequestId: input.requestId,
      jobIds: [],
      recommendations: authRequired ? ['重新完成 Google Workspace 授权后再恢复 Routine。'] : ['检查 Routine Run 和 Execution Job 证据后重试。'],
      data: { run },
    });
    throw error;
  }
}
