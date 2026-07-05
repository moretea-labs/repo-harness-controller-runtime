# Personal Assistant Rules and Reporting Runtime

This layer sits above the generic triage runtime. It answers two practical questions:

1. What should happen after an item is triaged?
2. Where should the daily report be delivered?

## Current delivery model

The safest report sink is `chatgpt`: the assistant summarizes in the current ChatGPT scheduled task and performs no writes. This is already useful for a daily brief, but it is not a repo-harness-native delivery channel.

The runtime therefore defines explicit report sinks:

- `chatgpt` — read-only scheduled daily brief.
- `gmail_draft` — creates a reviewable draft, never sends automatically.
- `notion_page` — writes a daily journal page after authorization.
- `github_issue` — appends or updates an issue for engineering workflows.
- `local_file` — writes a local markdown report in the repo-harness workspace.
- `repo_harness_worklog` — appends to the controller worklog.

Every sink declares risk and confirmation requirements. Remote-write sinks must remain disabled until the user explicitly enables and authorizes them.

## Default rules

The default profile keeps security, quota, billing, DevOps, and repository-security messages protected in the inbox. Low-value marketing and job messages can become delete candidates only when the sender is explicitly allowlisted. Learning and tool-update mail is archived rather than deleted.

This means the assistant can implement user preferences such as:

- Delete Spotify, Surveylama, repeated job digest, and obvious marketing candidates.
- Archive Preply because Calendar remains the source of truth for lessons.
- Archive ordinary tool updates.
- Keep Google security, Notion login, GitHub permissions, quota, storage, Vercel domain, and Dependabot alerts.

## Non-goals

- No permanent deletion.
- No automatic unsubscribe link clicking.
- No sending email without explicit authorization.
- No remote-write sink enabled by default.

## Integration path

1. Normalize connector objects into `AssistantItem`.
2. Run `triageItems`.
3. Run `buildDailyAssistantBrief`.
4. Render via `renderBriefMarkdown`.
5. Deliver to the selected sink only if its policy allows it.
6. Execute proposed actions only after the confirmation gate accepts the action batch.
