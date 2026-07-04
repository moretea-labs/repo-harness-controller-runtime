# Personal Assistant Plugin Baseline

> Status: **Runtime Authority**

This document defines the concrete baseline for the "personal assistant plugin"
surface inside the current repo-harness Controller Runtime. It exists to stop
"assistant", "plugin", "Gmail", and "Calendar" from being treated as one
undifferentiated feature set.

## 1. Current implementation boundary

Current implementation:

- repo-harness already implements a durable Controller Runtime, not a generic
  personal-app plugin host.
- First-class persisted plugins in source are the optional GitHub plugin under
  `src/cli/github/plugin.ts` plus Gmail, Google Calendar, and Google Tasks
  adapters under `src/runtime/plugins/`, all surfaced through Controller CLI,
  Local Bridge APIs, and MCP compatibility tools.
- ChatGPT browser automation exists under `src/cli/chatgpt-browser/` and the
  campaign/runtime control plane. It is an execution channel, not a plugin
  registry entry.
- Calendar support exists both as a runtime Schedule trigger under
  `src/runtime/workflow/schedules/` and as a separate Google Calendar account
  adapter under `src/runtime/plugins/`.
- Gmail, Calendar, and Tasks live-provider credentials are environment-only and
  are never persisted by this repository.

Architecture requirement:

- Docs and product language must distinguish repo-owned runtime capabilities,
  optional in-repo plugins with persisted config, and external Connector/app
  capabilities owned outside this repository.

Compatibility rule:

- Existing GitHub plugin behavior, runtime tool fingerprints, and packaging
  surfaces remain stable while assistant-oriented capabilities are clarified.

## 2. Concrete topology

```text
ChatGPT / Local UI / CLI
  -> MCP Gateway + Local Bridge
     -> Controller Runtime
        -> durable Jobs / campaigns / schedules / evidence
           -> optional provider adapters
              -> GitHub plugin (implemented)
              -> Gmail adapter (implemented)
              -> Google Calendar adapter (implemented)
              -> Google Tasks adapter (implemented)
              -> ChatGPT browser channel (implemented)
              -> Calendar trigger engine (implemented, separate from account adapter)
```

The runtime already owns admission, persistence, scheduling, isolation, and
evidence. "Personal assistant" behavior must therefore be modeled as bounded
operations on top of that runtime, not as a second orchestrator.

## 3. Capability matrix

| Capability | Source of truth | Persistence and boundary | External side effect | Status |
| --- | --- | --- | --- | --- |
| GitHub Issue/Project sync | `src/cli/github/plugin.ts`, `src/cli/commands/controller.ts`, `src/cli/local-bridge/server.ts` | `.repo-harness/plugins/github.json` plus repository registry mapping | GitHub issue/project mutation | Implemented |
| Durable assistant work submission | `src/runtime/gateway/mcp/runtime-tools.ts`, `src/runtime/execution/jobs/` | Controller Home `execution-jobs/`, events, artifacts, projections | Repository-local work and approved provider actions | Implemented |
| ChatGPT-supervised campaigns | `src/runtime/workflow/campaigns/`, `src/cli/chatgpt-browser/` | Campaign records, review packets, workspaces, evidence | Browser-visible ChatGPT session or delegated local work | Implemented and opt-in |
| Calendar time-based triggering | `src/runtime/workflow/schedules/store.ts`, `engine.ts` | Schedule, Decision, Occurrence records | Launches bounded runtime Jobs only | Implemented |
| Calendar account read/write | `src/runtime/plugins/google-calendar-adapter.ts` | `.repo-harness/plugins/google-calendar.json`, derived manifest/index, env-only credentials | Google Calendar event read/write | Implemented |
| Gmail mailbox read/write | `src/runtime/plugins/gmail-adapter.ts` | `.repo-harness/plugins/gmail.json`, derived manifest/index, env-only credentials | Gmail read/send/trash | Implemented |
| Google Tasks/reminder read/write | `src/runtime/plugins/google-tasks-adapter.ts` | `.repo-harness/plugins/google-tasks.json`, derived manifest/index, env-only credentials | Google Tasks list/task mutation | Implemented |
| Generic plugin manifest/registry for personal apps | `src/runtime/plugins/`, `src/runtime/gateway/mcp/runtime-tools.ts`, `src/cli/local-bridge/server.ts` | Controller Home `plugins/` manifest/index projections derived from existing authority | Typed plugin action dispatch into durable Jobs | Implemented |

## 4. Packaging baseline

Current implementation:

- `package.json` already ships `docs/architecture/`, runtime source, controller
  verification script, and ChatGPT bridge skills as part of the public package.
- `scripts/package-source-archive.sh` builds a portable archive from the working
  tree while rejecting symlinks and excluding runtime state, Git metadata, and
  secrets.

Architecture requirement:

- Assistant/plugin documentation must live under tracked docs already included in
  the public package; introducing a new baseline doc must not require shipping
  ignored runtime state or auth material.

Compatibility rule:

- Packaging must continue to exclude `.ai/` runtime state, local auth, tokens,
  and browser profile data even when assistant-oriented features expand.

## 5. Threat model

| Asset or boundary | Primary threat | Current controls | Remaining gap |
| --- | --- | --- | --- |
| Public `/mcp` endpoint and local Gateway | Remote callers trigger long or unsafe work through request lifetime coupling | Thin Gateway, durable acknowledgement, loopback local UI, auth, bounded toolsets, readiness checks | Tool-level capability descriptions are clearer than provider-level assistant semantics |
| Controller Home runtime state | Replayed or stale ownership mutates state after disconnect or restart | request-id dedupe, Leases, fencing, Operation Receipts, reconciliation, append-only events | Additional adapters beyond GitHub still need the same registry contract |
| GitHub plugin config and repo mapping | Wrong repository/project mapping or silent remote mutation | explicit config, readiness probe, derived plugin manifests, action-scoped confirmation, warnings on remote drift | Google adapters use separate config authority and do not reuse GitHub registry mapping |
| Browser-based ChatGPT automation | Session leakage, default-profile misuse, invisible side effects | dedicated profile guidance, CDP default-profile block, bounded capture, opt-in workflow, evidence records | Browser channel is still an execution transport, not a typed assistant-provider contract |
| Gmail/Calendar/Tasks adapters | Overbroad mailbox/calendar/task scope and opaque side effects | read/write scope separation, action-scoped confirmation, env-only credentials, mock/live provider split, durable audit events, structured provider errors | No OAuth refresh/token broker is implemented; operators must supply short-lived access tokens outside repo state |
| Local visual controller | Exposure beyond loopback or secret leakage in logs | loopback bind enforcement, token auth, bounded snapshots, redaction paths | Personal-app views do not exist yet, so no specialized redaction policy is defined |

## 6. Migration plan

### Phase A — Name the real provider classes

- Keep "GitHub plugin", "ChatGPT browser channel", and "Schedule trigger"
  separate in docs and CLI help.
- Describe Gmail, Google Calendar, and Google Tasks as implemented runtime
  plugins only through the generic plugin contract; do not present them as
  browser-channel or schedule-engine features.

### Phase B — Add a typed assistant-provider contract

Current implementation:

- The runtime now exposes a generic personal-assistant plugin contract with:
  versioned manifests, derived registry/discovery, lifecycle/health, typed
  action schemas, permission scopes, confirmation policies, idempotent durable
  action dispatch, cancellation/timeout support through `ExecutionJob`, and
  plugin audit events in the runtime ledger.
- The first adapter is GitHub. Its configuration authority remains the existing
  repository registry plus `.repo-harness/plugins/github.json`; the generic
  manifest is a derived projection, not a second source of truth.

- Introduce one provider contract for personal-app adapters with capability id,
  read/write scope declaration, persisted config shape, readiness probe,
  audit/evidence schema, env-only credential rule, and explicit
  external-side-effect classification.
- Reuse existing Controller authorization, durable Job, and evidence layers
  instead of bypassing them.

### Phase C — Run Gmail, Calendar, and Tasks adapters only behind the contract

- Gmail is implemented as a bounded mailbox adapter with list/read, draft,
  send, and trash actions.
- Calendar is implemented as an account adapter distinct from the existing
  time-trigger engine, with list/read, create, reschedule, and cancel actions.
- Tasks is implemented as a reminder/task adapter with list/create/update,
  reschedule, complete, and delete actions.
- All three emit provider/action audit events, structured provider failures, and
  integrate with existing approval and release boundaries.

### Phase D — Preserve public package and source-archive invariants

- Keep docs, scripts, and public source packaged.
- Keep runtime state, auth material, browser profiles, and local Connector
  secrets excluded from npm and source archives.
- Extend focused checks before any new assistant provider becomes part of the
  public contract.

## 7. Delivery conclusion

The current source-aligned assistant baseline is:

- Controller Runtime plus durable Jobs/campaigns/schedules are the assistant
  execution substrate.
- GitHub, Gmail, Google Calendar, and Google Tasks are implemented persisted
  plugin adapters behind the generic plugin runtime contract.
- Generic plugin discovery, typed action execution, confirmation policy and
  audit events are implemented through the runtime `plugins/` layer.
- ChatGPT browser automation is an opt-in execution channel.
- Calendar exists both as a scheduling primitive and as a separate Google
  Calendar account adapter.
- Live Google credentials remain environment-only; this repo persists plugin
  config and derived health, not tokens.
