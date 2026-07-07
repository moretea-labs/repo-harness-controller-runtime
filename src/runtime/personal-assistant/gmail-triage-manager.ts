import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import type { AssistantPluginManifest } from '../plugins/types';
import {
  defaultTriageRules,
  normalizeAssistantItem,
  triageItems,
  type AssistantItem,
  type TriageDecision,
  type TriageRule,
} from './triage-runtime';

export interface GmailTriageRuleStore {
  schemaVersion: 1;
  updatedAt: string;
  rules: TriageRule[];
}

export interface GmailTriageSummary {
  total: number;
  byPriority: Record<string, number>;
  byCategory: Record<string, number>;
  requiresUserInput: number;
  remoteWriteActions: number;
}

export interface GmailTriagePlan {
  repoId: string;
  generatedAt: string;
  plugin: {
    pluginId: 'gmail';
    configured: boolean;
    enabled: boolean;
    ready: boolean;
    healthState?: string;
    warnings: string[];
    next: string[];
  };
  query: string;
  rulesPath: string;
  ruleCount: number;
  summary: GmailTriageSummary;
  decisions: TriageDecision[];
  actionQueue: Array<{
    actionId: string;
    sourceId: string;
    type: string;
    risk: string;
    requiresConfirmation: boolean;
    summary: string;
    executableByPlugin: boolean;
    pluginActionId?: string;
    arguments?: Record<string, unknown>;
  }>;
  next: string[];
}

export interface GmailTriageRuleUpsertResult {
  path: string;
  rule: TriageRule;
  store: GmailTriageRuleStore;
}

const RULE_PATH = '.repo-harness/assistant/gmail-triage-rules.json';

function now(): string {
  return new Date().toISOString();
}

function rulePath(repository: RepositoryRecord): string {
  return join(repository.canonicalRoot, RULE_PATH);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function readStoredRules(repository: RepositoryRecord): GmailTriageRuleStore | undefined {
  const path = rulePath(repository);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GmailTriageRuleStore>;
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
  };
}

function normalizeRule(input: Record<string, unknown>, existing?: TriageRule): TriageRule {
  const id = String(input.id ?? existing?.id ?? '').trim();
  if (!id) throw new Error('GMAIL_TRIAGE_RULE_ID_REQUIRED');
  const match = input.match && typeof input.match === 'object' && !Array.isArray(input.match)
    ? input.match as TriageRule['match']
    : existing?.match;
  const decision = input.decision && typeof input.decision === 'object' && !Array.isArray(input.decision)
    ? input.decision as TriageRule['decision']
    : existing?.decision;
  if (!match) throw new Error('GMAIL_TRIAGE_RULE_MATCH_REQUIRED');
  if (!decision) throw new Error('GMAIL_TRIAGE_RULE_DECISION_REQUIRED');
  return {
    id,
    enabled: input.enabled === undefined ? existing?.enabled ?? true : input.enabled === true,
    order: typeof input.order === 'number' ? Math.trunc(input.order) : existing?.order ?? 50,
    match,
    decision,
  };
}

export function readGmailTriageRules(repository: RepositoryRecord): GmailTriageRuleStore {
  const stored = readStoredRules(repository);
  if (stored) return stored;
  return { schemaVersion: 1, updatedAt: now(), rules: defaultTriageRules() };
}

export function upsertGmailTriageRule(repository: RepositoryRecord, input: Record<string, unknown>): GmailTriageRuleUpsertResult {
  const store = readGmailTriageRules(repository);
  const id = String(input.id ?? '').trim();
  const existing = store.rules.find((rule) => rule.id === id);
  const rule = normalizeRule(input, existing);
  const next: GmailTriageRuleStore = {
    schemaVersion: 1,
    updatedAt: now(),
    rules: [rule, ...store.rules.filter((entry) => entry.id !== rule.id)].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
  };
  writeJson(rulePath(repository), next);
  return { path: RULE_PATH, rule, store: next };
}

function normalizedItems(items: unknown): AssistantItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => normalizeAssistantItem({
      source: 'gmail',
      source_id: String(entry.source_id ?? entry.sourceId ?? entry.id ?? entry.message_id ?? '').trim(),
      kind: 'email',
      title: String(entry.title ?? entry.subject ?? entry.snippet ?? '').trim(),
      body: typeof entry.body === 'string' ? entry.body : typeof entry.snippet === 'string' ? entry.snippet : undefined,
      actor: typeof entry.actor === 'string' ? entry.actor : typeof entry.from === 'string' ? entry.from : undefined,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : typeof entry.date === 'string' ? entry.date : undefined,
      labels: Array.isArray(entry.labels) ? entry.labels.map(String) : Array.isArray(entry.label_ids) ? entry.label_ids.map(String) : undefined,
      urls: Array.isArray(entry.urls) ? entry.urls.map(String) : undefined,
      attachments: Array.isArray(entry.attachments) ? entry.attachments as AssistantItem['attachments'] : undefined,
      metadata: { ...entry },
    }))
    .filter((item) => item.source_id && item.title);
}

function pluginSummary(manifest: AssistantPluginManifest | undefined) {
  const actions = new Set(manifest?.actions.map((action) => action.actionId) ?? []);
  const ready = manifest?.enabled === true && manifest.health.ready === true;
  const next: string[] = [];
  if (!manifest) next.push('Initialize or enable the Gmail plugin manifest.');
  else if (!manifest.enabled) next.push('Configure the Gmail plugin before trying to read mail.');
  else if (!ready) next.push('Fix Gmail plugin health warnings before executing Gmail actions.');
  return {
    pluginId: 'gmail' as const,
    configured: Boolean(manifest),
    enabled: manifest?.enabled === true,
    ready,
    healthState: manifest?.health.state,
    warnings: [...(manifest?.health.warnings ?? []), ...(manifest?.health.errors ?? [])],
    next,
    actions,
  };
}

function summarize(decisions: TriageDecision[]): GmailTriageSummary {
  const byPriority: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let remoteWriteActions = 0;
  for (const decision of decisions) {
    byPriority[decision.priority] = (byPriority[decision.priority] ?? 0) + 1;
    byCategory[decision.category] = (byCategory[decision.category] ?? 0) + 1;
    remoteWriteActions += decision.suggested_actions.filter((action) => action.risk !== 'readonly').length;
  }
  return {
    total: decisions.length,
    byPriority,
    byCategory,
    requiresUserInput: decisions.filter((decision) => decision.requires_user_input).length,
    remoteWriteActions,
  };
}

function pluginActionFor(type: string): string | undefined {
  if (type === 'archive' || type === 'mark_read' || type === 'label') return undefined;
  if (type === 'draft_reply') return 'create_draft';
  return undefined;
}

export function buildGmailTriagePlan(repository: RepositoryRecord, input: { manifest?: AssistantPluginManifest; items?: unknown; query?: unknown } = {}): GmailTriagePlan {
  const rules = readGmailTriageRules(repository).rules;
  const items = normalizedItems(input.items);
  const decisions = triageItems(items, { rules, low_value_action_mode: 'archive_candidate' })
    .sort((left, right) => left.priority.localeCompare(right.priority) || right.confidence - left.confidence);
  const plugin = pluginSummary(input.manifest);
  const actionQueue = decisions.flatMap((decision) => decision.suggested_actions.map((action) => {
    const pluginActionId = pluginActionFor(action.type);
    return {
      actionId: action.id,
      sourceId: decision.source_id,
      type: action.type,
      risk: action.risk,
      requiresConfirmation: action.requires_confirmation,
      summary: action.summary,
      executableByPlugin: Boolean(pluginActionId && plugin.ready && plugin.actions.has(pluginActionId)),
      pluginActionId,
      arguments: action.arguments,
    };
  }));
  const next = [
    ...(items.length === 0 ? ['Fetch messages with the Gmail plugin list_messages action, then pass summaries into gmail_triage_plan.'] : []),
    ...(actionQueue.some((action) => action.requiresConfirmation) ? ['Review remote-write action proposals before executing any Gmail mutations.'] : []),
    ...plugin.next,
  ];
  return {
    repoId: repository.repoId,
    generatedAt: now(),
    plugin: { pluginId: plugin.pluginId, configured: plugin.configured, enabled: plugin.enabled, ready: plugin.ready, healthState: plugin.healthState, warnings: plugin.warnings, next: plugin.next },
    query: String(input.query ?? 'in:inbox newer_than:14d').trim(),
    rulesPath: RULE_PATH,
    ruleCount: rules.length,
    summary: summarize(decisions),
    decisions,
    actionQueue,
    next: [...new Set(next)],
  };
}
