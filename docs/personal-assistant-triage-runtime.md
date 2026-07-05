# Personal Assistant Triage Runtime

This patch intentionally avoids a Gmail-specific mail-rule engine. It adds a generic triage runtime that can accept normalized assistant items from Gmail, Google Calendar, GitHub, Slack, Notion, browser pages, repository events, and system notifications.

## Boundary

The model should keep doing semantic work:

- summarize items;
- infer category and priority;
- explain why an item needs attention;
- draft replies or follow-up text.

The runtime should provide durable, auditable infrastructure:

- normalize connector-specific records into `AssistantItem`;
- apply deterministic preference rules before or after model triage;
- produce typed `TriageDecision` objects;
- produce typed `ActionProposal` objects;
- mark all remote-write actions as requiring explicit confirmation;
- preserve evidence excerpts and matched rule ids for audit/replay.

## Data flow

```text
Connector records
  Gmail / Calendar / GitHub / Slack / Notion / Browser / Repository
        ↓
AssistantItem
        ↓
Rule pre-filter + heuristic fallback
        ↓
TriageDecision
        ↓
ActionProposal
        ↓
Policy gate + user confirmation
        ↓
Plugin executor
        ↓
Audit log / preference rule update
```

## Integration points

Suggested wiring in the existing runtime:

1. Add the new file under `src/runtime/personal-assistant/triage-runtime.ts`.
2. In the personal-assistant plugin runtime, map connector action results into `AssistantItem`.
3. Call `triageItems(items, { rules: defaultTriageRules() })` for the first implementation.
4. Return `TriageDecision[]` from assistant readiness / inbox summary APIs.
5. Convert `ActionProposal` into existing plugin actions only after policy validation.
6. Persist user-created preference rules separately from default rules.

## Safety model

`ActionProposal.risk` intentionally distinguishes:

- `readonly`: inspect, summarize, verify account activity;
- `workspace_write`: local workspace changes;
- `remote_write`: Gmail labels/archive, calendar creation, GitHub comments/issues;
- `destructive`: delete, send, payment, publish, irreversible actions.

This patch only proposes remote write actions; it does not execute them. Execution should remain behind existing confirmation gates.

## Why this is better than a mail rule engine

A Gmail-only rule engine would quickly become too narrow. The same triage machinery is needed for:

- security alerts from email and browser pages;
- repository/CI failures from GitHub and repo-harness;
- scheduled lessons from Gmail and Calendar;
- API quota or billing warnings from email and dashboards;
- Slack/Notion work items.

The runtime therefore owns structure and safety, while ChatGPT owns semantic judgment.
