import { describe, expect, it } from "bun:test";
import type { AssistantItem } from "../../src/runtime/personal-assistant/triage-runtime";
import {
  buildDailyAssistantBrief,
  DEFAULT_ASSISTANT_RULE_PROFILE,
  proposeAssistantActions,
  renderBriefMarkdown,
} from "../../src/runtime/personal-assistant/reporting-runtime";
import { triageItems } from "../../src/runtime/personal-assistant/triage-runtime";

function email(source_id: string, actor: string, title: string, body = ""): AssistantItem {
  return {
    source: "gmail",
    source_id,
    kind: "email",
    actor,
    title,
    body,
    timestamp: "2026-07-05T08:00:00Z",
    labels: ["INBOX"],
  };
}

describe("personal assistant reporting runtime", () => {
  it("keeps security, quota, devops, and repository alerts protected", () => {
    const items = [
      email("google-security", "Google <no-reply@accounts.google.com>", "Security alert", "You allowed OpenAI access to Google Account data."),
      email("storage", "Google <google-noreply@google.com>", "Your Gmail storage is 81% full", "12.27 GB used of 15 GB."),
      email("vercel-domain", "Vercel <notifications@vercel.com>", "2 domains need configuration", "moretea.top is misconfigured."),
      email("dependabot", "GitHub <noreply@github.com>", "Dependabot alerts", "Critical severity vulnerability."),
    ];

    const brief = buildDailyAssistantBrief(items, { now: "2026-07-05T08:00:00Z" });

    expect(brief.protected_count).toBe(4);
    expect(brief.sections.find((section) => section.id === "urgent")?.items.length).toBeGreaterThan(0);
    expect(brief.proposed_actions.every((action) => action.type !== "archive")).toBe(true);
  });

  it("proposes delete candidates only for allowlisted low-value senders", () => {
    const items = [
      email("spotify", "Spotify <no-reply@spotify.com>", "Ready for ad-free music listening again?", "Rejoin Premium."),
      email("survey", "Surveylama <julie@surveylama.com>", "Want more surveys?", "Take another survey."),
      email("unknown-marketing", "Unknown <promo@example.com>", "Premium webinar", "Join this promotion."),
    ];

    const decisions = triageItems(items);
    const actions = proposeAssistantActions(items, decisions, DEFAULT_ASSISTANT_RULE_PROFILE);

    const deleteCandidates = actions.filter((action) => action.summary.startsWith("Delete candidate"));
    expect(deleteCandidates).toHaveLength(2);
    expect(deleteCandidates.every((action) => action.risk === "remote_write")).toBe(true);
    expect(deleteCandidates.every((action) => action.requires_confirmation)).toBe(true);
  });

  it("archives learning and tool-update senders without deleting them", () => {
    const items = [
      email("preply", "Preply <noreply@trans.preply.com>", "Your English lesson is coming up", "Join your lesson."),
      email("openrouter", "OpenRouter <welcome@openrouter.ai>", "What shipped on OpenRouter in June", "Product update."),
    ];

    const brief = buildDailyAssistantBrief(items, { now: "2026-07-05T08:00:00Z" });
    const archiveActions = brief.proposed_actions.filter((action) => action.type === "archive");

    expect(archiveActions).toHaveLength(2);
    expect(archiveActions.every((action) => action.requires_confirmation)).toBe(true);
  });

  it("renders a markdown report suitable for ChatGPT, Notion, or local files", () => {
    const brief = buildDailyAssistantBrief(
      [email("storage", "Google <google-noreply@google.com>", "Your Gmail storage is 81% full", "12.27 GB used of 15 GB.")],
      { now: "2026-07-05T08:00:00Z" },
    );

    const markdown = renderBriefMarkdown(brief);

    expect(markdown).toContain("# Daily Assistant Brief");
    expect(markdown).toContain("Report sink: ChatGPT daily assistant brief");
    expect(markdown).toContain("Your Gmail storage is 81% full");
  });
});
