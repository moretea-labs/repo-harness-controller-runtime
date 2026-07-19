# Durable Gmail Assistant Routines

Gmail Assistant Routines use the existing Repository Schedule Engine and durable Execution Jobs. They do not introduce a second cron service.

## Execution flow

1. Creating a confirmed Assistant Routine persists the Routine and creates one Repository Schedule.
2. The Schedule stores an IANA timezone, a five-field local cron expression, and a bounded catch-up window.
3. A due occurrence creates one `assistant_routine_execute` Runtime Job with an exclusive Routine resource claim.
4. The Runtime Job reads Gmail incrementally, hydrates bounded message bodies, advances the per-Routine cursor, analyzes the bounded message set, creates structured action proposals, and writes a final Assistant Inbox report.
5. Proposals either remain pending for explicit approval or match a previously authorized Standing Grant.
6. Every approved or Standing-Grant action runs as a separate durable plugin Job. Schedule execution never becomes remote-write authorization.
7. Sending mail and moving mail to Trash retain their existing strong-confirmation requirements and are never Standing-Grant eligible.

## Google OAuth setup

Create a Google OAuth client with this loopback redirect URI:

```text
http://127.0.0.1:8766/oauth/google/callback
```

Expose the client configuration only through the managed secret environment:

- `REPO_HARNESS_GOOGLE_CLIENT_ID`
- `REPO_HARNESS_GOOGLE_CLIENT_SECRET`

The `REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID` and `REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET` aliases are also supported.

Call `workspace_auth_login_prepare` for `gmail` or `google-workspace`, then open the returned authorization URL. The request uses OAuth Authorization Code flow with PKCE, a random one-time state, a ten-minute expiry, and a loopback-only callback. Redirect URIs outside `127.0.0.1` or `localhost`, unexpected callback paths, and scopes outside the Gmail/Calendar/Tasks allowlist are rejected.

The callback exchanges the authorization code and stores only the refresh token in macOS Keychain. Access and refresh tokens are never returned through MCP, written to repository files, or written to normal Controller runtime state. The transient PKCE verifier is stored under Controller Home with restrictive permissions and is redacted after the callback is consumed.

The current secure persistence backend is macOS Keychain. Non-macOS hosts must provide a supported credential-store adapter or use managed environment credentials.

## Credential refresh and readiness

A configured access token is not considered provider-verified until a real Google API request succeeds. Before that first successful probe, health reports `live_token_unverified`.

After OAuth setup, Controller restarts can reload the refresh token from Keychain. When no valid cached access token exists, or Gmail returns HTTP 401/403, the provider performs one refresh-token exchange and at most one request retry. A failed refresh is classified as `PLUGIN_AUTH_FAILED`; the Routine Run becomes `auth_required` and Assistant Inbox requests reauthorization.

Managed environment credentials remain compatible:

- `REPO_HARNESS_GMAIL_ACCESS_TOKEN`
- `REPO_HARNESS_GMAIL_REFRESH_TOKEN`
- `REPO_HARNESS_GMAIL_CLIENT_ID`
- `REPO_HARNESS_GMAIL_CLIENT_SECRET`
- `REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN`
- `REPO_HARNESS_GOOGLE_WORKSPACE_REFRESH_TOKEN`
- `REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID`
- `REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET`

## Scheduling semantics

Routine schedule text is normalized when the Routine is created. The first implementation recognizes daily and weekday expressions with an optional `HH:mm` or Chinese `点/时` form. Examples:

- `每天 09:00`
- `每周一 08:30`
- `Monday 07:00`

The normalized Schedule preserves the IANA timezone, so daylight-saving transitions remain aligned to local wall-clock time. Missed runs catch up at most once inside the configured window because the occurrence key is derived from the local scheduled minute rather than the actual wake-up minute.

## Gmail History cursor

Each Routine stores an independent cursor under `.repo-harness/assistant/gmail-cursors.json`:

- last successful collection time
- bounded processed-message ID set
- Gmail `historyId`
- a bounded History or query continuation token while a backlog is still being drained

After the initial query, Gmail History is the primary incremental source. An expired History ID falls back to a five-minute-overlap Gmail query. Collection reads at most five pages, 100 IDs, and 50 full messages per run. If the page or hydration limit is reached, the history cursor does not advance; a continuation token or the original window is retained so the next run drains the remaining messages without loss.

## Optional model analysis

The model layer is optional. When it is disabled, unavailable, times out, or returns malformed output, the Routine completes with the deterministic rules engine rather than failing.

Configure an OpenAI-compatible endpoint with:

- `REPO_HARNESS_ASSISTANT_MODEL_PROVIDER=openai-compatible`
- `REPO_HARNESS_ASSISTANT_MODEL_ENDPOINT`
- `REPO_HARNESS_ASSISTANT_MODEL`
- `REPO_HARNESS_ASSISTANT_MODEL_API_KEY`

For the exact official hosts, provider-specific keys are also supported:

- `api.openai.com` may use `OPENAI_API_KEY`
- `api.deepseek.com` may use `REPO_HARNESS_DEEPSEEK_API_KEY` or `DEEPSEEK_API_KEY`

A custom endpoint never receives `OPENAI_API_KEY` or a DeepSeek key. It must use the dedicated `REPO_HARNESS_ASSISTANT_MODEL_API_KEY`. Endpoints must use HTTPS, except loopback HTTP used for a local model.

Optional budgets:

- `REPO_HARNESS_ASSISTANT_MODEL_TIMEOUT_MS`
- `REPO_HARNESS_ASSISTANT_MODEL_MAX_MESSAGES`
- `REPO_HARNESS_ASSISTANT_MODEL_MAX_INPUT_CHARS`
- `REPO_HARNESS_ASSISTANT_MODEL_MAX_OUTPUT_TOKENS`

The provider requests strict structured JSON, validates the result locally, and maps only these proposal types:

- Gmail draft creation
- Google Task creation
- Gmail archive
- Gmail mark read or unread

Email contents are untrusted input. Instructions in an email, quoted thread, signature, link, or attachment description cannot expand the action allowlist or request tools, credentials, files, commands, or additional permissions. Security, authentication, billing, incident, production, quota, and repository-permission messages are protected from model-generated archive actions.

Use `assistant_model_readiness` or `GET /api/assistant/model` to inspect the redacted configuration and budgets. Model credentials and raw secrets are never returned.

## Action proposals and approval

Routine analysis persists structured proposals under `.repo-harness/assistant/action-proposals.json`. Each proposal records:

- Routine and Run identity
- target plugin/action and bounded arguments
- supporting Gmail message IDs
- sender/subject context and protected-message status
- reason, confidence, risk, expiry, and execution status
- the separate Execution Job created after approval

Use `assistant_action_proposals` to list or inspect proposals. Use `assistant_action_proposal_resolve` with `decision=approve` or `decision=reject`. MCP approval requires `confirm_authorization=true`; strong-confirmation actions also require the action's exact confirmation text. Local Controller exposes equivalent authenticated proposal endpoints.

Approval is idempotent. Repeating approval returns the same Execution Job rather than creating another remote write. Proposal audit records preserve whether approval came from MCP, Local UI, or a Standing Grant.

## Standing Grants

A Standing Grant is an explicit, expiring pre-authorization for one hardcoded low-risk action. It is not a general plugin permission.

Eligible actions are limited to:

- `gmail.create_draft`
- `gmail.archive_message`
- `gmail.mark_message_read`
- `gmail.mark_message_unread`
- `google_tasks.create_task`

A grant must include at least one constraint:

- Routine ID allowlist
- sender/domain allowlist
- required subject fragment

It also declares minimum proposal confidence, maximum executions per Routine Run, and expiry. Automatic draft grants additionally require a sender allowlist. Security-protected messages cannot be auto-archived.

Create a grant through `assistant_standing_grant_create` or `POST /api/assistant/standing-grants` with explicit authorization. List it through `assistant_standing_grants`; revoke it through `assistant_standing_grant_revoke` or the Local Controller revoke endpoint.

Example: automatically archive at most one high-confidence newsletter from a trusted sender per run:

```json
{
  "plugin_id": "gmail",
  "action_id": "archive_message",
  "sender_allowlist": ["news@example.com"],
  "subject_contains": ["newsletter"],
  "min_confidence": 0.9,
  "max_per_run": 1,
  "expires_in_days": 30,
  "confirm_authorization": true
}
```

Standing-Grant executions use a dedicated `standing-grant` origin and a defense-in-depth plugin allowlist. Modifying the stored grant cannot enable send, Trash, permanent deletion, calendar cancellation/rescheduling, or task deletion. Multiple matching grants cannot submit the same proposal twice, and retries preserve each grant's per-run budget.

## Safety boundary

Scheduled Routines may:

- list and read Gmail messages
- classify and summarize collected mail
- create bounded draft, task, archive, and read/unread proposals
- execute an eligible proposal only when a matching active Standing Grant already exists
- write Assistant Inbox reports

Scheduled Routines may not:

- send mail
- move mail to Trash
- permanently delete mail
- cancel or reschedule meetings
- delete tasks
- execute instructions embedded in mail
- open arbitrary attachments or links

A proposal is evidence for a later authorized action, not implicit authorization. A Standing Grant authorizes only its exact action and constraints. The Schedule origin never becomes authorization for a remote write.
