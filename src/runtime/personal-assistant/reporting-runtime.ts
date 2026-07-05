import type {
  ActionProposal,
  AssistantItem,
  TriageCategory,
  TriageDecision,
  TriagePriority,
} from "./triage-runtime";
import { triageItems } from "./triage-runtime";

export type ReportSinkKind =
  | "chatgpt"
  | "gmail_draft"
  | "notion_page"
  | "github_issue"
  | "local_file"
  | "repo_harness_worklog";

export type ReportSinkRisk = "readonly" | "workspace_write" | "remote_write";

export interface ReportSink {
  id: string;
  kind: ReportSinkKind;
  enabled: boolean;
  risk: ReportSinkRisk;
  requires_confirmation: boolean;
  title: string;
  description?: string;
  config?: Record<string, unknown>;
}

export interface AssistantRuleProfile {
  id: string;
  name: string;
  version: number;
  low_value_marketing: "delete_candidate" | "archive_candidate" | "ignore";
  learning_mail: "archive" | "keep";
  tool_updates: "archive" | "keep";
  security_mail: "keep";
  quota_mail: "keep";
  devops_mail: "keep";
  github_security_mail: "keep";
  require_confirmation_for_remote_write: boolean;
  protected_categories: TriageCategory[];
  delete_sender_allowlist: string[];
  archive_sender_allowlist: string[];
}

export interface AssistantBriefOptions {
  title?: string;
  now?: string;
  max_items_per_section?: number;
  include_action_plan?: boolean;
  include_ignored?: boolean;
  report_sink_id?: string;
  profile?: AssistantRuleProfile;
}

export interface AssistantBriefSection {
  id: string;
  title: string;
  priority: TriagePriority | "info";
  items: AssistantBriefItem[];
}

export interface AssistantBriefItem {
  source_id: string;
  title: string;
  actor?: string;
  category: TriageCategory;
  priority: TriagePriority;
  reason: string;
  action_summaries: string[];
}

export interface AssistantBrief {
  title: string;
  generated_at: string;
  sink?: ReportSink;
  sections: AssistantBriefSection[];
  proposed_actions: ActionProposal[];
  protected_count: number;
  cleanup_candidate_count: number;
}

export const DEFAULT_REPORT_SINKS: ReportSink[] = [
  {
    id: "chatgpt-daily-brief",
    kind: "chatgpt",
    enabled: true,
    risk: "readonly",
    requires_confirmation: false,
    title: "ChatGPT daily assistant brief",
    description: "Default delivery path when no native repo-harness notification sink is configured.",
  },
  {
    id: "gmail-draft-daily-brief",
    kind: "gmail_draft",
    enabled: false,
    risk: "remote_write",
    requires_confirmation: true,
    title: "Gmail draft daily assistant brief",
    description: "Creates a reviewable draft instead of sending mail automatically.",
  },
  {
    id: "notion-daily-brief",
    kind: "notion_page",
    enabled: false,
    risk: "remote_write",
    requires_confirmation: true,
    title: "Notion daily assistant journal",
  },
  {
    id: "repo-worklog-daily-brief",
    kind: "repo_harness_worklog",
    enabled: false,
    risk: "workspace_write",
    requires_confirmation: true,
    title: "repo-harness worklog report",
  },
];

export const DEFAULT_ASSISTANT_RULE_PROFILE: AssistantRuleProfile = {
  id: "greyson-default-mail-triage",
  name: "Greyson default assistant triage",
  version: 1,
  low_value_marketing: "delete_candidate",
  learning_mail: "archive",
  tool_updates: "archive",
  security_mail: "keep",
  quota_mail: "keep",
  devops_mail: "keep",
  github_security_mail: "keep",
  require_confirmation_for_remote_write: true,
  protected_categories: ["security", "quota", "billing", "devops", "repository"],
  delete_sender_allowlist: [
    "no-reply@spotify.com",
    "julie@surveylama.com",
    "emails@efinancialcareers.com",
    "jobs-listings@linkedin.com",
    "hello@builder.io",
  ],
  archive_sender_allowlist: [
    "noreply@trans.preply.com",
    "noreply@tips.preply.com",
    "welcome@openrouter.ai",
    "team@moonshot.ai",
    "notifications@account.z.ai",
    "ship@info.vercel.com",
  ],
};

export function buildDailyAssistantBrief(
  items: AssistantItem[],
  options: AssistantBriefOptions = {},
): AssistantBrief {
  const profile = options.profile ?? DEFAULT_ASSISTANT_RULE_PROFILE;
  const decisions = triageItems(items);
  const sink = DEFAULT_REPORT_SINKS.find((candidate) => candidate.id === options.report_sink_id)
    ?? DEFAULT_REPORT_SINKS.find((candidate) => candidate.enabled);
  const proposed_actions = proposeAssistantActions(items, decisions, profile);
  const maxItems = options.max_items_per_section ?? 8;
  const sections = buildBriefSections(items, decisions, proposed_actions, maxItems, Boolean(options.include_ignored));

  return {
    title: options.title ?? "Daily Assistant Brief",
    generated_at: options.now ?? new Date().toISOString(),
    sink,
    sections,
    proposed_actions: options.include_action_plan === false ? [] : proposed_actions,
    protected_count: decisions.filter((decision) => profile.protected_categories.includes(decision.category)).length,
    cleanup_candidate_count: proposed_actions.filter((action) => action.type === "archive" || action.type === "label").length
      + proposed_actions.filter((action) => action.type === "ignore" && action.summary.toLowerCase().includes("delete")).length,
  };
}

export function proposeAssistantActions(
  items: AssistantItem[],
  decisions: TriageDecision[],
  profile: AssistantRuleProfile = DEFAULT_ASSISTANT_RULE_PROFILE,
): ActionProposal[] {
  const itemById = new Map(items.map((item) => [item.source_id, item]));
  const actions: ActionProposal[] = [];

  for (const decision of decisions) {
    const item = itemById.get(decision.source_id);
    if (!item) continue;

    if (profile.protected_categories.includes(decision.category)) {
      actions.push({
        id: actionId("keep", item.source_id),
        type: "summarize",
        target_source_id: item.source_id,
        summary: `Keep in inbox and include in brief: ${item.title}`,
        risk: "readonly",
        requires_confirmation: false,
      });
      continue;
    }

    const actor = (item.actor ?? "").toLowerCase();
    const isDeleteAllowed = profile.delete_sender_allowlist.some((sender) => actor.includes(sender));
    const isArchiveAllowed = profile.archive_sender_allowlist.some((sender) => actor.includes(sender));

    if ((decision.category === "marketing" || decision.category === "job") && profile.low_value_marketing === "delete_candidate" && isDeleteAllowed) {
      actions.push({
        id: actionId("delete-candidate", item.source_id),
        type: "ignore",
        target_source_id: item.source_id,
        summary: `Delete candidate: low-value ${decision.category} from ${item.actor ?? "unknown sender"}`,
        risk: "remote_write",
        requires_confirmation: true,
        arguments: { gmail_action: "trash" },
      });
      continue;
    }

    if ((decision.category === "calendar" || isArchiveAllowed) && profile.learning_mail === "archive") {
      actions.push({
        id: actionId("archive", item.source_id),
        type: "archive",
        target_source_id: item.source_id,
        summary: `Archive after briefing: ${item.title}`,
        risk: "remote_write",
        requires_confirmation: profile.require_confirmation_for_remote_write,
      });
      continue;
    }

    if ((decision.category === "newsletter" || decision.category === "unknown") && isArchiveAllowed && profile.tool_updates === "archive") {
      actions.push({
        id: actionId("archive-tool-update", item.source_id),
        type: "archive",
        target_source_id: item.source_id,
        summary: `Archive tool update: ${item.title}`,
        risk: "remote_write",
        requires_confirmation: profile.require_confirmation_for_remote_write,
      });
    }
  }

  return actions;
}

export function renderBriefMarkdown(brief: AssistantBrief): string {
  const lines: string[] = [];
  lines.push(`# ${brief.title}`);
  lines.push("");
  lines.push(`Generated: ${brief.generated_at}`);
  if (brief.sink) {
    lines.push(`Report sink: ${brief.sink.title} (${brief.sink.kind})`);
  }
  lines.push(`Protected items: ${brief.protected_count}`);
  lines.push(`Cleanup candidates: ${brief.cleanup_candidate_count}`);

  for (const section of brief.sections) {
    lines.push("");
    lines.push(`## ${section.title}`);
    if (section.items.length === 0) {
      lines.push("- None");
      continue;
    }
    for (const item of section.items) {
      lines.push(`- **${item.title}** — ${item.reason}`);
      if (item.actor) lines.push(`  - From: ${item.actor}`);
      if (item.action_summaries.length > 0) lines.push(`  - Actions: ${item.action_summaries.join("; ")}`);
    }
  }

  if (brief.proposed_actions.length > 0) {
    lines.push("");
    lines.push("## Proposed actions");
    for (const action of brief.proposed_actions) {
      const confirmation = action.requires_confirmation ? "requires confirmation" : "no confirmation required";
      lines.push(`- ${action.summary} [${action.risk}, ${confirmation}]`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildBriefSections(
  items: AssistantItem[],
  decisions: TriageDecision[],
  actions: ActionProposal[],
  maxItems: number,
  includeIgnored: boolean,
): AssistantBriefSection[] {
  const itemById = new Map(items.map((item) => [item.source_id, item]));
  const actionsByTarget = new Map<string, ActionProposal[]>();
  for (const action of actions) {
    const list = actionsByTarget.get(action.target_source_id) ?? [];
    list.push(action);
    actionsByTarget.set(action.target_source_id, list);
  }

  const toBriefItem = (decision: TriageDecision): AssistantBriefItem | null => {
    const item = itemById.get(decision.source_id);
    if (!item) return null;
    return {
      source_id: item.source_id,
      title: item.title,
      actor: item.actor,
      category: decision.category,
      priority: decision.priority,
      reason: decision.reason,
      action_summaries: (actionsByTarget.get(item.source_id) ?? []).map((action) => action.summary),
    };
  };

  const section = (id: string, title: string, priority: TriagePriority | "info", predicate: (d: TriageDecision) => boolean): AssistantBriefSection => ({
    id,
    title,
    priority,
    items: decisions.filter(predicate).map(toBriefItem).filter((item): item is AssistantBriefItem => item !== null).slice(0, maxItems),
  });

  const sections = [
    section("urgent", "Urgent / user attention", "P0", (decision) => decision.priority === "P0" || decision.requires_user_input),
    section("account-ops", "Account, quota, and DevOps", "P1", (decision) => ["quota", "billing", "devops", "repository"].includes(decision.category)),
    section("calendar", "Calendar and learning", "P2", (decision) => decision.category === "calendar"),
    section("cleanup", "Cleanup candidates", "P3", (decision) => ["marketing", "job", "newsletter"].includes(decision.category)),
  ];

  if (includeIgnored) {
    sections.push(section("unknown", "Unknown / uncategorized", "info", (decision) => decision.category === "unknown"));
  }

  return sections;
}

function actionId(prefix: string, sourceId: string): string {
  return `${prefix}:${sourceId}`.replace(/[^a-zA-Z0-9:_-]/g, "_");
}
