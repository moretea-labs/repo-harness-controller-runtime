# Google Assistant Plugins

This document covers the repo-owned Gmail, Google Calendar, and Google Tasks
assistant plugins exposed by the generic runtime plugin surface.

## Plugin IDs

- `gmail`
- `google_calendar`
- `google_tasks`

Each plugin is discoverable through:

- `list_plugins`
- `get_plugin`
- `plugin_action_execute`

## Configuration Authority

The runtime stores only non-secret plugin configuration under:

- `.repo-harness/plugins/gmail.json`
- `.repo-harness/plugins/google-calendar.json`
- `.repo-harness/plugins/google-tasks.json`

Credentials are never written to repository files, Controller Home state, or
plugin manifests.

## Credential Sources

Live Google Workspace provider mode reads bearer tokens only from process
environment variables:

- Gmail: `REPO_HARNESS_GMAIL_ACCESS_TOKEN`, `REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN`, `REPO_HARNESS_GOOGLE_ACCESS_TOKEN`
- Calendar: `REPO_HARNESS_GOOGLE_CALENDAR_ACCESS_TOKEN`, `REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN`, `REPO_HARNESS_GOOGLE_ACCESS_TOKEN`
- Tasks: `REPO_HARNESS_GOOGLE_TASKS_ACCESS_TOKEN`, `REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN`, `REPO_HARNESS_GOOGLE_ACCESS_TOKEN`

For local development and contract tests, each plugin also supports
`provider: "mock"` with deterministic mock responses and no credential
requirements.

## Readiness diagnostics

Plugin health exposes an explicit `readinessMode` in `health.details`:

| Mode | Meaning |
| --- | --- |
| `disabled` | Plugin is not enabled |
| `mock_provider_ready` | Mock provider is configured and ready (no token needed) |
| `live_provider_ready` | Live Google Workspace mode has a bearer token |
| `missing_token` | Live mode selected but no env token is present |
| `missing_scopes` | Reserved for future scope probes |

Important: missing live credentials are reported as **degraded / needs setup**,
not as a generic plugin failure. Mock mode remains fully usable for verification
without tokens. `userFacingStatus` summarizes this as `disabled`, `mock ready`,
`live token missing`, or `ready`.

## Permission Model

Scopes are declared separately for read and write operations:

- Gmail: `gmail.readonly`, `gmail.compose`, `gmail.send`, `gmail.modify`
- Calendar: `calendar.events.readonly`, `calendar.events.write`, `calendar.events.delete`
- Tasks: `tasks.readonly`, `tasks.write`, `tasks.delete`

The manifest reports each scope independently even when the same bearer token is
used by the live provider.

## Confirmation Policy

Configuration writes require `confirm_authorization=true`.

Consequential remote writes require stronger confirmation:

- Gmail `send_message`: `confirmation_text=send-gmail-message`
- Gmail `trash_message`: `confirmation_text=trash-gmail-message`
- Calendar `reschedule_event`: `confirmation_text=reschedule-calendar-event`
- Calendar `cancel_event`: `confirmation_text=cancel-calendar-event`
- Tasks `reschedule_task`: `confirmation_text=reschedule-google-task`
- Tasks `delete_task`: `confirmation_text=delete-google-task`

Lower-risk writes such as drafts, event creation, task creation, and task
completion still require authorization but not strong confirmation text.

## Failure Contract

Provider failures remain structured through durable `ExecutionJob` errors:

- `PLUGIN_AUTH_REQUIRED`
- `PLUGIN_AUTH_FAILED`
- `PLUGIN_RATE_LIMITED`
- `PLUGIN_PROVIDER_TIMEOUT`
- `PLUGIN_PROVIDER_UNAVAILABLE`
- `PLUGIN_PROVIDER_ERROR`

Plugin audit events record `plugin_action_requested`, `plugin_action_succeeded`,
and `plugin_action_failed`.


## Mobile Shortcuts / Siri Entry Point

The Local Controller also exposes a mobile intent layer for phone-side voice/text automation. Device tokens are created through the authenticated Local UI API, stored only as SHA-256 hashes, and scoped to explicit plugin actions such as `plugin:gmail:send_message` or `plugin:google_tasks:create_task`.

The mobile endpoint is `/mobile/intent`. Requests require a device ID, bearer token, fresh timestamp, unique nonce, and optional HMAC-SHA256 signature over `<timestamp>.<nonce>.<raw-json-body>`. Nonces are retained for replay protection, revoked devices are rejected, and per-device rate limits are enforced before any plugin action is accepted.

When a mobile Shortcut submits a write action without the required authorization or strong confirmation text, the endpoint returns `approvalRequired: true` and the exact confirmation text instead of silently running the action. The Shortcut can then ask the user to confirm and retry, or poll the returned durable Execution Job when accepted.

See `docs/operations/mobile-intents-shortcuts.md` for the iPhone Shortcuts request contract and setup examples.
