# Personal assistant operator guide

This runtime is intended to be used with ChatGPT as the primary control plane. The Local Controller is the execution, policy, audit, and persistence layer.

## Recommended daily path

1. Ask ChatGPT for the goal in natural language.
2. ChatGPT calls the high-level assistant API or MCP tools.
3. The runtime plans safe plugin actions, submits durable jobs, and writes results into Assistant Inbox.
4. High-risk actions stay blocked until explicit human confirmation.

## Readiness check

Use `assistant_readiness` or `GET /api/assistant/readiness` before relying on the assistant.

The report separates:

- live Google capability
- mock-only capability
- disabled plugins
- routine, inbox, and memory state
- recommended next actions

Mock mode proves the execution path only. It does not read real Gmail, Calendar, or Tasks data.

## Gmail read self-test

A low-risk Gmail read test can be submitted through either:

- `plugin_action_execute` with `gmail.list_messages`
- `POST /api/assistant/self-test/gmail-read`
- `POST /api/assistant/intent` with an utterance such as `测试读取最近一周 Gmail`

When Gmail is in mock mode, the test returns deterministic mock messages. For real Gmail, configure the plugin with provider `google-workspace` and set one of the supported token environment variables documented by the plugin health message.

## Cleanup workflow

Use `runtime_cleanup_preview` or `POST /api/assistant/maintenance/cleanup-preview` first. It is non-destructive.

Use cleanup apply only after reviewing the preview:

- `runtime_cleanup_apply` with `confirm_cleanup=true`
- `POST /api/assistant/maintenance/cleanup-apply` with `confirmCleanup=true`

Cleanup is limited to explicit repo-harness candidates:

- old `repo-harness-*` temp directories that are not referenced by running processes
- terminal local jobs, when explicitly included
- historical attention acknowledgements, when explicitly included

Do not use cleanup apply as a substitute for reviewing active jobs, active leases, or running workers.

## What still needs real productization

The current runtime can route assistant intents and run safe data collection jobs. A full personal-assistant product still needs:

- real OAuth/token broker and refresh support
- wall-clock routine scheduling
- model-backed summarization of collected data
- approval summaries for risky actions
- cleanup apply integration in a dedicated maintenance UI
