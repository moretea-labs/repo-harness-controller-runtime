# Durable Gmail Assistant Routines

Gmail Assistant Routines use the existing Repository Schedule Engine and durable Execution Jobs. They do not introduce a second cron service.

## Execution flow

1. Creating a confirmed Assistant Routine persists the Routine and creates one Repository Schedule.
2. The Schedule stores an IANA timezone, a five-field local cron expression, and a bounded catch-up window.
3. A due occurrence creates one `assistant_routine_execute` Runtime Job with an exclusive Routine resource claim.
4. The Runtime Job reads Gmail pages, hydrates bounded message bodies, advances the per-Routine cursor, and writes a final Assistant Inbox report.
5. Sending mail and moving mail to Trash remain outside unattended execution and still require explicit confirmation.

## Google credentials

A configured access token is not considered provider-ready until a real Google API request succeeds. Before the first successful probe, health reports `live_token_unverified`.

For unattended operation, configure these values through the existing managed secret environment, never repository files:

- `REPO_HARNESS_GMAIL_ACCESS_TOKEN`
- `REPO_HARNESS_GMAIL_REFRESH_TOKEN`
- `REPO_HARNESS_GMAIL_CLIENT_ID`
- `REPO_HARNESS_GMAIL_CLIENT_SECRET`

Workspace-wide aliases are also supported:

- `REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN`
- `REPO_HARNESS_GOOGLE_WORKSPACE_REFRESH_TOKEN`
- `REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID`
- `REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET`

On HTTP 401/403, the provider performs at most one refresh-token exchange and one retry. A failed refresh is classified as `PLUGIN_AUTH_FAILED`; the Routine Run becomes `auth_required` and an Assistant Inbox item requests reauthorization.

## Scheduling semantics

Routine schedule text is normalized when the Routine is created. The first implementation recognizes daily and weekday expressions with an optional `HH:mm` or Chinese `点/时` form. Examples:

- `每天 09:00`
- `每周一 08:30`
- `Monday 07:00`

The normalized Schedule preserves the IANA timezone, so daylight-saving transitions remain aligned to local wall-clock time. Missed runs catch up at most once inside the configured window because the occurrence key is derived from the local scheduled minute rather than the actual wake-up minute.

## Gmail cursor

Each Routine stores an independent cursor under `.repo-harness/assistant/gmail-cursors.json`:

- last successful collection time
- bounded processed-message ID set
- optional provider history ID

Collection uses a five-minute overlap and message-ID deduplication. It reads at most five pages, 100 IDs, and 50 full messages per run. Cursor advancement occurs only after collection and final report creation succeed.

## Safety boundary

Scheduled Routines may:

- list and read Gmail messages
- classify and summarize collected mail
- propose reply, task, and archive candidates
- write Assistant Inbox reports

Scheduled Routines may not:

- send mail
- move mail to Trash
- permanently delete mail
- execute instructions embedded in mail
- open arbitrary attachments or links

Proposals are evidence for a later authorized action, not implicit authorization.
