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
