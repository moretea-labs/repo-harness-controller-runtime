export type AssistantSource =
  | "gmail"
  | "calendar"
  | "github"
  | "slack"
  | "notion"
  | "browser"
  | "repository"
  | "system"
  | "unknown";

export type AssistantItemKind =
  | "email"
  | "calendar_event"
  | "issue"
  | "pull_request"
  | "message"
  | "web_page"
  | "notification"
  | "repository_event"
  | "unknown";

export type TriageCategory =
  | "security"
  | "billing"
  | "quota"
  | "devops"
  | "calendar"
  | "job"
  | "newsletter"
  | "marketing"
  | "personal"
  | "repository"
  | "unknown";

export type TriagePriority = "P0" | "P1" | "P2" | "P3";

export type AssistantActionRisk =
  | "readonly"
  | "workspace_write"
  | "remote_write"
  | "destructive";

export type AssistantActionType =
  | "open_url"
  | "mark_read"
  | "archive"
  | "label"
  | "draft_reply"
  | "create_task"
  | "create_calendar_event"
  | "verify_account_activity"
  | "inspect_billing_or_quota"
  | "inspect_devops_configuration"
  | "summarize"
  | "ignore";

export interface AssistantAttachmentRef {
  id?: string;
  name?: string;
  mime_type?: string;
  size_bytes?: number;
}

export interface AssistantItem {
  source: AssistantSource;
  source_id: string;
  kind: AssistantItemKind;
  title: string;
  body?: string;
  actor?: string;
  timestamp?: string;
  labels?: string[];
  urls?: string[];
  attachments?: AssistantAttachmentRef[];
  metadata?: Record<string, unknown>;
}

export interface TriageEvidenceRef {
  source_id: string;
  field: "title" | "body" | "actor" | "label" | "url" | "metadata" | "rule";
  excerpt: string;
}

export interface ActionProposal {
  id: string;
  type: AssistantActionType;
  target_source_id: string;
  summary: string;
  risk: AssistantActionRisk;
  requires_confirmation: boolean;
  arguments?: Record<string, unknown>;
}

export interface TriageDecision {
  source_id: string;
  category: TriageCategory;
  priority: TriagePriority;
  confidence: number;
  reason: string;
  evidence: TriageEvidenceRef[];
  suggested_actions: ActionProposal[];
  matched_rule_ids: string[];
  requires_user_input: boolean;
}

export interface TriageRuleMatch {
  sources?: AssistantSource[];
  kinds?: AssistantItemKind[];
  actor_includes?: string[];
  title_includes?: string[];
  body_includes?: string[];
  label_includes?: string[];
  url_host_includes?: string[];
  metadata_equals?: Record<string, string | number | boolean>;
}

export interface TriageRuleDecision {
  category?: TriageCategory;
  priority?: TriagePriority;
  confidence?: number;
  reason?: string;
  requires_user_input?: boolean;
  suggested_actions?: Omit<ActionProposal, "id" | "target_source_id">[];
}

export interface TriageRule {
  id: string;
  enabled?: boolean;
  order?: number;
  match: TriageRuleMatch;
  decision: TriageRuleDecision;
}

export interface TriageRuntimeOptions {
  rules?: TriageRule[];
  default_priority?: TriagePriority;
  low_value_action_mode?: "ignore" | "archive_candidate";
}

interface HeuristicSignal {
  category: TriageCategory;
  priority: TriagePriority;
  confidence: number;
  reason: string;
  evidence: TriageEvidenceRef[];
  actionTypes: AssistantActionType[];
  requiresUserInput: boolean;
}

const SECURITY_TERMS = [
  "new device",
  "logged into",
  "login",
  "password",
  "mfa",
  "multi-factor",
  "2fa",
  "permission",
  "permissions",
  "authorized",
  "re-authorized",
  "third-party",
  "security alert",
  "suspicious",
];

const BILLING_TERMS = [
  "storage",
  "quota",
  "usage",
  "minutes",
  "billing",
  "invoice",
  "budget",
  "credits",
  "balance",
  "额度",
  "余额",
  "即将用尽",
  "用尽",
  "充值",
];

const DEVOPS_TERMS = [
  "misconfigured",
  "configuration",
  "domain",
  "dns",
  "deploy",
  "deployment",
  "build failed",
  "pipeline",
  "actions minutes",
  "workflow",
  "certificate",
];

const CALENDAR_TERMS = ["lesson", "meeting", "calendar", "event", "appointment", "class", "课程", "会议"];
const JOB_TERMS = ["job", "hiring", "engineer", "recruiter", "interview", "career", "招聘", "面试"];
const MARKETING_TERMS = ["premium", "survey", "webinar", "newsletter", "promo", "promotion", "discount", "优惠"];

export function normalizeAssistantItem(input: AssistantItem): AssistantItem {
  if (!input.source_id || !input.source_id.trim()) {
    throw new Error("AssistantItem.source_id is required");
  }
  if (!input.title || !input.title.trim()) {
    throw new Error(`AssistantItem.title is required for ${input.source}:${input.source_id}`);
  }

  return {
    source: input.source ?? "unknown",
    source_id: input.source_id.trim(),
    kind: input.kind ?? "unknown",
    title: input.title.trim(),
    body: normalizeOptionalText(input.body),
    actor: normalizeOptionalText(input.actor),
    timestamp: normalizeOptionalText(input.timestamp),
    labels: dedupeStrings(input.labels),
    urls: dedupeStrings(input.urls),
    attachments: input.attachments ?? [],
    metadata: input.metadata ?? {},
  };
}

export function triageItems(items: AssistantItem[], options: TriageRuntimeOptions = {}): TriageDecision[] {
  const normalized = items.map(normalizeAssistantItem);
  const rules = [...(options.rules ?? [])]
    .filter((rule) => rule.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return normalized.map((item) => triageItem(item, rules, options));
}

export function triageItem(
  item: AssistantItem,
  rules: TriageRule[] = [],
  options: TriageRuntimeOptions = {},
): TriageDecision {
  const normalized = normalizeAssistantItem(item);
  const matchedRules = rules.filter((rule) => ruleMatches(normalized, rule.match));
  const heuristic = classifyByHeuristics(normalized, options);

  const decision = matchedRules.reduce<TriageDecision>(
    (current, rule) => mergeRuleDecision(current, normalized, rule),
    signalToDecision(normalized, heuristic),
  );

  return {
    ...decision,
    confidence: clampConfidence(decision.confidence),
    evidence: compactEvidence(decision.evidence),
    suggested_actions: dedupeActions(decision.suggested_actions),
    matched_rule_ids: matchedRules.map((rule) => rule.id),
  };
}

export function ruleMatches(item: AssistantItem, match: TriageRuleMatch): boolean {
  if (match.sources?.length && !match.sources.includes(item.source)) return false;
  if (match.kinds?.length && !match.kinds.includes(item.kind)) return false;
  if (match.actor_includes?.length && !containsAny(item.actor, match.actor_includes)) return false;
  if (match.title_includes?.length && !containsAny(item.title, match.title_includes)) return false;
  if (match.body_includes?.length && !containsAny(item.body, match.body_includes)) return false;
  if (match.label_includes?.length && !arrayContainsAny(item.labels, match.label_includes)) return false;
  if (match.url_host_includes?.length && !urlHostsContainAny(item.urls, match.url_host_includes)) return false;

  if (match.metadata_equals) {
    for (const [key, expected] of Object.entries(match.metadata_equals)) {
      if (item.metadata?.[key] !== expected) return false;
    }
  }

  return true;
}

export function defaultTriageRules(): TriageRule[] {
  return [
    {
      id: "github-third-party-permissions",
      order: 10,
      match: {
        sources: ["gmail"],
        actor_includes: ["github"],
        title_includes: ["third-party", "permissions"],
      },
      decision: {
        category: "security",
        priority: "P0",
        confidence: 0.96,
        reason: "GitHub third-party application permission changes require explicit account-owner review.",
        requires_user_input: true,
        suggested_actions: [
          {
            type: "verify_account_activity",
            summary: "Open GitHub authorized applications and verify the permission change.",
            risk: "readonly",
            requires_confirmation: false,
          },
        ],
      },
    },
    {
      id: "new-device-login-alert",
      order: 20,
      match: {
        title_includes: ["new device", "logged into"],
      },
      decision: {
        category: "security",
        priority: "P0",
        confidence: 0.95,
        reason: "New-device login alerts are high-priority until the user confirms the login was expected.",
        requires_user_input: true,
        suggested_actions: [
          {
            type: "verify_account_activity",
            summary: "Review recent account activity and confirm the login was expected.",
            risk: "readonly",
            requires_confirmation: false,
          },
        ],
      },
    },
    {
      id: "quota-or-storage-warning",
      order: 30,
      match: {
        title_includes: ["storage", "quota", "usage", "额度", "用尽"],
      },
      decision: {
        category: "quota",
        priority: "P1",
        confidence: 0.9,
        reason: "Quota and storage warnings can block future automated workflows.",
        requires_user_input: false,
        suggested_actions: [
          {
            type: "inspect_billing_or_quota",
            summary: "Inspect the current usage or balance before it blocks workflows.",
            risk: "readonly",
            requires_confirmation: false,
          },
        ],
      },
    },
    {
      id: "domain-configuration-warning",
      order: 40,
      match: {
        title_includes: ["domain", "configuration", "misconfigured"],
        body_includes: ["domain"],
      },
      decision: {
        category: "devops",
        priority: "P1",
        confidence: 0.91,
        reason: "Domain configuration warnings can indicate broken production or preview routing.",
        requires_user_input: false,
        suggested_actions: [
          {
            type: "inspect_devops_configuration",
            summary: "Inspect the referenced domain or deployment configuration.",
            risk: "readonly",
            requires_confirmation: false,
          },
        ],
      },
    },
    {
      id: "low-value-marketing",
      order: 90,
      match: {
        title_includes: ["premium", "survey", "webinar", "newsletter"],
      },
      decision: {
        category: "marketing",
        priority: "P3",
        confidence: 0.78,
        reason: "Marketing and newsletter content is low priority unless the user has a saved interest rule.",
        requires_user_input: false,
        suggested_actions: [
          {
            type: "ignore",
            summary: "Keep out of the main action list.",
            risk: "readonly",
            requires_confirmation: false,
          },
        ],
      },
    },
  ];
}

function classifyByHeuristics(item: AssistantItem, options: TriageRuntimeOptions): HeuristicSignal {
  const corpus = [item.title, item.body, item.actor, ...(item.labels ?? []), ...(item.urls ?? [])]
    .filter(Boolean)
    .join("\n");

  const securityEvidence = evidenceForTerms(item, SECURITY_TERMS);
  if (securityEvidence.length > 0) {
    return {
      category: "security",
      priority: "P0",
      confidence: 0.88,
      reason: "The item contains account-security or authorization signals.",
      evidence: securityEvidence,
      actionTypes: ["verify_account_activity", "open_url"],
      requiresUserInput: true,
    };
  }

  const billingEvidence = evidenceForTerms(item, BILLING_TERMS);
  if (billingEvidence.length > 0) {
    return {
      category: corpus.toLowerCase().includes("quota") || corpus.includes("额度") ? "quota" : "billing",
      priority: "P1",
      confidence: 0.82,
      reason: "The item contains quota, balance, storage, billing, or usage signals.",
      evidence: billingEvidence,
      actionTypes: ["inspect_billing_or_quota", "open_url"],
      requiresUserInput: false,
    };
  }

  const devopsEvidence = evidenceForTerms(item, DEVOPS_TERMS);
  if (devopsEvidence.length > 0) {
    return {
      category: "devops",
      priority: "P1",
      confidence: 0.8,
      reason: "The item contains deployment, domain, workflow, or configuration signals.",
      evidence: devopsEvidence,
      actionTypes: ["inspect_devops_configuration", "open_url"],
      requiresUserInput: false,
    };
  }

  const calendarEvidence = evidenceForTerms(item, CALENDAR_TERMS);
  if (calendarEvidence.length > 0 || item.kind === "calendar_event") {
    return {
      category: "calendar",
      priority: "P2",
      confidence: item.kind === "calendar_event" ? 0.86 : 0.72,
      reason: "The item appears to be a scheduled event or reminder.",
      evidence: calendarEvidence.length ? calendarEvidence : fallbackEvidence(item, "metadata", item.kind),
      actionTypes: ["create_task", "summarize"],
      requiresUserInput: false,
    };
  }

  const jobEvidence = evidenceForTerms(item, JOB_TERMS);
  if (jobEvidence.length > 0) {
    return {
      category: "job",
      priority: "P2",
      confidence: 0.7,
      reason: "The item appears to be a recruiting, job, or interview signal.",
      evidence: jobEvidence,
      actionTypes: ["summarize"],
      requiresUserInput: false,
    };
  }

  const marketingEvidence = evidenceForTerms(item, MARKETING_TERMS);
  if (marketingEvidence.length > 0) {
    const actionType: AssistantActionType =
      options.low_value_action_mode === "archive_candidate" ? "archive" : "ignore";
    return {
      category: "marketing",
      priority: "P3",
      confidence: 0.68,
      reason: "The item appears to be marketing, newsletter, or survey content.",
      evidence: marketingEvidence,
      actionTypes: [actionType],
      requiresUserInput: false,
    };
  }

  if (item.source === "github" || item.kind === "issue" || item.kind === "pull_request") {
    return {
      category: "repository",
      priority: options.default_priority ?? "P2",
      confidence: 0.65,
      reason: "The item comes from a repository source and should enter the engineering triage lane.",
      evidence: fallbackEvidence(item, "metadata", item.source),
      actionTypes: ["create_task", "open_url"],
      requiresUserInput: false,
    };
  }

  return {
    category: "unknown",
    priority: options.default_priority ?? "P3",
    confidence: 0.45,
    reason: "No strong triage signal was found; keep it out of high-priority action lists.",
    evidence: fallbackEvidence(item, "title", item.title),
    actionTypes: ["summarize"],
    requiresUserInput: false,
  };
}

function signalToDecision(item: AssistantItem, signal: HeuristicSignal): TriageDecision {
  return {
    source_id: item.source_id,
    category: signal.category,
    priority: signal.priority,
    confidence: signal.confidence,
    reason: signal.reason,
    evidence: signal.evidence,
    suggested_actions: signal.actionTypes.map((type, index) => actionForType(item, type, index)),
    matched_rule_ids: [],
    requires_user_input: signal.requiresUserInput,
  };
}

function mergeRuleDecision(decision: TriageDecision, item: AssistantItem, rule: TriageRule): TriageDecision {
  const patch = rule.decision;
  const ruleEvidence: TriageEvidenceRef = {
    source_id: item.source_id,
    field: "rule",
    excerpt: `Matched triage rule: ${rule.id}`,
  };

  const actions = (patch.suggested_actions ?? []).map((action, index) => ({
    ...action,
    id: actionId(item.source_id, action.type, index + decision.suggested_actions.length),
    target_source_id: item.source_id,
  }));

  return {
    ...decision,
    category: patch.category ?? decision.category,
    priority: patch.priority ?? decision.priority,
    confidence: Math.max(decision.confidence, patch.confidence ?? decision.confidence),
    reason: patch.reason ?? decision.reason,
    requires_user_input: patch.requires_user_input ?? decision.requires_user_input,
    evidence: [...decision.evidence, ruleEvidence],
    suggested_actions: actions.length ? [...decision.suggested_actions, ...actions] : decision.suggested_actions,
  };
}

function actionForType(item: AssistantItem, type: AssistantActionType, index: number): ActionProposal {
  const risk: AssistantActionRisk = actionRisk(type);
  return {
    id: actionId(item.source_id, type, index),
    type,
    target_source_id: item.source_id,
    summary: summaryForAction(type, item),
    risk,
    requires_confirmation: risk !== "readonly",
    arguments: defaultArgumentsForAction(type, item),
  };
}

function actionRisk(type: AssistantActionType): AssistantActionRisk {
  switch (type) {
    case "mark_read":
    case "archive":
    case "label":
    case "draft_reply":
    case "create_task":
    case "create_calendar_event":
      return "remote_write";
    case "open_url":
    case "verify_account_activity":
    case "inspect_billing_or_quota":
    case "inspect_devops_configuration":
    case "summarize":
    case "ignore":
    default:
      return "readonly";
  }
}

function summaryForAction(type: AssistantActionType, item: AssistantItem): string {
  switch (type) {
    case "open_url":
      return "Open the referenced URL for read-only inspection.";
    case "verify_account_activity":
      return "Verify whether the account activity was expected.";
    case "inspect_billing_or_quota":
      return "Inspect usage, quota, balance, or billing state.";
    case "inspect_devops_configuration":
      return "Inspect the referenced deployment, domain, or configuration state.";
    case "archive":
      return "Archive this low-priority item after user authorization.";
    case "mark_read":
      return "Mark this item as read after user authorization.";
    case "label":
      return "Apply a triage label after user authorization.";
    case "draft_reply":
      return "Draft a reply without sending it.";
    case "create_task":
      return "Create a follow-up task from this item.";
    case "create_calendar_event":
      return "Create or update a calendar event from this item.";
    case "ignore":
      return "Do not include this item in the main action list.";
    case "summarize":
    default:
      return `Summarize ${item.title}.`;
  }
}

function defaultArgumentsForAction(type: AssistantActionType, item: AssistantItem): Record<string, unknown> | undefined {
  if (type === "open_url" && item.urls?.length) {
    return { url: item.urls[0] };
  }
  if (type === "label") {
    return { label: "assistant-triaged" };
  }
  if (type === "create_task") {
    return { title: item.title, source: item.source, source_id: item.source_id };
  }
  return undefined;
}

function evidenceForTerms(item: AssistantItem, terms: string[]): TriageEvidenceRef[] {
  const fields: Array<[TriageEvidenceRef["field"], string | undefined]> = [
    ["title", item.title],
    ["body", item.body],
    ["actor", item.actor],
    ["label", item.labels?.join(" ")],
    ["url", item.urls?.join(" ")],
  ];

  const evidence: TriageEvidenceRef[] = [];
  for (const [field, value] of fields) {
    if (!value) continue;
    const matched = terms.find((term) => includesNormalized(value, term));
    if (matched) {
      evidence.push({ source_id: item.source_id, field, excerpt: excerptAround(value, matched) });
    }
  }
  return evidence.slice(0, 4);
}

function fallbackEvidence(item: AssistantItem, field: TriageEvidenceRef["field"], value: string): TriageEvidenceRef[] {
  return [{ source_id: item.source_id, field, excerpt: value.slice(0, 160) }];
}

function containsAny(value: string | undefined, needles: string[]): boolean {
  return Boolean(value && needles.some((needle) => includesNormalized(value, needle)));
}

function arrayContainsAny(values: string[] | undefined, needles: string[]): boolean {
  if (!values?.length) return false;
  return needles.some((needle) => values.some((value) => includesNormalized(value, needle)));
}

function urlHostsContainAny(urls: string[] | undefined, needles: string[]): boolean {
  if (!urls?.length) return false;
  return urls.some((url) => {
    const host = safeHost(url);
    return needles.some((needle) => includesNormalized(host, needle));
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function includesNormalized(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function excerptAround(value: string, needle: string): string {
  const lower = value.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index < 0) return value.slice(0, 160);
  const start = Math.max(0, index - 48);
  const end = Math.min(value.length, index + needle.length + 96);
  return value.slice(start, end).replace(/\s+/g, " ").trim();
}

function compactEvidence(evidence: TriageEvidenceRef[]): TriageEvidenceRef[] {
  const seen = new Set<string>();
  const compact: TriageEvidenceRef[] = [];
  for (const item of evidence) {
    const key = `${item.field}:${item.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compact.push(item);
  }
  return compact.slice(0, 8);
}

function dedupeActions(actions: ActionProposal[]): ActionProposal[] {
  const seen = new Set<string>();
  const result: ActionProposal[] = [];
  for (const action of actions) {
    const key = `${action.type}:${action.target_source_id}:${action.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function actionId(sourceId: string, type: AssistantActionType, index: number): string {
  const safeSource = sourceId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `${safeSource}_${type}_${index + 1}`;
}

function dedupeStrings(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function clampConfidence(confidence: number): number {
  if (Number.isNaN(confidence)) return 0.5;
  return Math.max(0, Math.min(1, Number(confidence.toFixed(3))));
}
