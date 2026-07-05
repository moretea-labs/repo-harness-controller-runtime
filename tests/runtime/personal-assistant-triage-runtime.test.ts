import { describe, expect, it } from "bun:test";
import {
  defaultTriageRules,
  triageItem,
  triageItems,
  type AssistantItem,
  type TriageRule,
} from "../../src/runtime/personal-assistant/triage-runtime";

describe("personal assistant triage runtime", () => {
  it("classifies new-device login alerts as P0 security items", () => {
    const decision = triageItem(
      {
        source: "gmail",
        source_id: "notion-login-1",
        kind: "email",
        actor: "Notion Team notify@updates.notion.so",
        title: "A new device logged into your account",
        body: "Login with Google from Mac in San Jose. If this was not you, reset your password.",
      },
      defaultTriageRules(),
    );

    expect(decision.category).toBe("security");
    expect(decision.priority).toBe("P0");
    expect(decision.requires_user_input).toBe(true);
    expect(decision.suggested_actions.some((action) => action.type === "verify_account_activity")).toBe(true);
    expect(decision.suggested_actions.every((action) => action.risk === "readonly")).toBe(true);
  });

  it("classifies quota and storage warnings without requiring immediate user input", () => {
    const decision = triageItem(
      {
        source: "gmail",
        source_id: "google-storage-1",
        kind: "email",
        actor: "Google google-noreply@google.com",
        title: "Your Gmail storage is 81% full",
        body: "12.27 GB used of 15 GB shared across Drive, Gmail, and Photos.",
      },
      defaultTriageRules(),
    );

    expect(decision.category).toBe("quota");
    expect(decision.priority).toBe("P1");
    expect(decision.requires_user_input).toBe(false);
    expect(decision.suggested_actions.some((action) => action.type === "inspect_billing_or_quota")).toBe(true);
  });

  it("classifies deployment and domain configuration warnings as devops", () => {
    const decision = triageItem(
      {
        source: "gmail",
        source_id: "vercel-domain-1",
        kind: "email",
        actor: "Vercel notifications@vercel.com",
        title: "2 domains need configuration",
        body: "Project metrome has misconfigured domains: moretea.top and www.moretea.top.",
      },
      defaultTriageRules(),
    );

    expect(decision.category).toBe("devops");
    expect(decision.priority).toBe("P1");
    expect(decision.suggested_actions.some((action) => action.type === "inspect_devops_configuration")).toBe(true);
  });

  it("keeps low-value marketing out of the main action lane", () => {
    const decision = triageItem(
      {
        source: "gmail",
        source_id: "spotify-1",
        kind: "email",
        actor: "Spotify no-reply@spotify.com",
        title: "Ready for ad-free music listening again?",
        body: "Rejoin Premium for uninterrupted music.",
      },
      defaultTriageRules(),
    );

    expect(decision.category).toBe("marketing");
    expect(decision.priority).toBe("P3");
    expect(decision.suggested_actions.some((action) => action.type === "ignore")).toBe(true);
  });

  it("allows user preference rules to override heuristic classification", () => {
    const rules: TriageRule[] = [
      {
        id: "keep-preply-lessons-visible",
        order: 1,
        match: { actor_includes: ["preply"], title_includes: ["lesson"] },
        decision: {
          category: "calendar",
          priority: "P1",
          confidence: 0.93,
          reason: "The user wants lesson reminders surfaced in the daily assistant view.",
          suggested_actions: [
            {
              type: "create_task",
              summary: "Create a lesson preparation task.",
              risk: "remote_write",
              requires_confirmation: true,
            },
          ],
        },
      },
    ];

    const decision = triageItem(
      {
        source: "gmail",
        source_id: "preply-lesson-1",
        kind: "email",
        actor: "Preply noreply@trans.preply.com",
        title: "Your English lesson is coming up",
        body: "Show up for your future self.",
      },
      rules,
    );

    expect(decision.category).toBe("calendar");
    expect(decision.priority).toBe("P1");
    expect(decision.matched_rule_ids).toEqual(["keep-preply-lessons-visible"]);
    expect(decision.suggested_actions.some((action) => action.type === "create_task")).toBe(true);
    expect(decision.suggested_actions.some((action) => action.requires_confirmation)).toBe(true);
  });

  it("triages heterogeneous assistant items through a shared normalized interface", () => {
    const items: AssistantItem[] = [
      {
        source: "github",
        source_id: "repo-issue-7",
        kind: "issue",
        title: "CI pipeline failed after browser plugin change",
        body: "The workflow failed during typecheck.",
      },
      {
        source: "calendar",
        source_id: "event-1",
        kind: "calendar_event",
        title: "Preply lesson - Amir R.",
      },
    ];

    const decisions = triageItems(items, { rules: defaultTriageRules() });

    expect(decisions).toHaveLength(2);
    expect(decisions[0].category).toBe("devops");
    expect(decisions[1].category).toBe("calendar");
  });
});
