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
- The only first-class persisted plugin in source is the optional GitHub plugin
  under `src/cli/github/plugin.ts`, surfaced through Controller CLI, Local
  Bridge APIs, and MCP compatibility tools.
- ChatGPT browser automation exists under `src/cli/chatgpt-browser/` and the
  campaign/runtime control plane. It is an execution channel, not a plugin
  registry entry.
- Calendar support exists only as a runtime Schedule trigger under
  `src/runtime/workflow/schedules/`; there is no Google Calendar account sync
  adapter in this repository.
- Gmail account access is not implemented in repository source. Any Gmail
  capability must come from an external ChatGPT Connector, browser session, or a
  future adapter that does not yet exist here.

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
              -> ChatGPT browser channel (implemented)
              -> Calendar trigger engine (implemented, no calendar account adapter)
              -> Gmail adapter (not implemented)
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
| Calendar account read/write | none in repo source | none | none | Not implemented |
| Gmail mailbox read/write | none in repo source | none | none | Not implemented |
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
| GitHub plugin config and repo mapping | Wrong repository/project mapping or silent remote mutation | explicit config, readiness probe, derived plugin manifests, action-scoped confirmation, warnings on remote drift | Only GitHub is modeled; future personal-app adapters need the same guardrails |
| Browser-based ChatGPT automation | Session leakage, default-profile misuse, invisible side effects | dedicated profile guidance, CDP default-profile block, bounded capture, opt-in workflow, evidence records | Browser channel is still an execution transport, not a typed assistant-provider contract |
| Future Gmail/Calendar adapters | Overbroad mailbox/calendar scope and opaque side effects | none in source today; must currently stay out of scope | Missing adapter contract, consent model, and evidence schema |
| Local visual controller | Exposure beyond loopback or secret leakage in logs | loopback bind enforcement, token auth, bounded snapshots, redaction paths | Personal-app views do not exist yet, so no specialized redaction policy is defined |

## 6. Migration plan

### Phase A — Name the real provider classes

- Keep "GitHub plugin", "ChatGPT browser channel", and "Schedule trigger"
  separate in docs and CLI help.
- Do not describe Gmail or Calendar as implemented plugin capabilities until
  source, tests, persistence, and governance exist.

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
  audit/evidence schema, and explicit external-side-effect classification.
- Reuse existing Controller authorization, durable Job, and evidence layers
  instead of bypassing them.

### Phase C — Add Gmail and Calendar adapters only behind the contract

- Gmail must enter as an adapter with bounded mailbox actions and redaction
  rules.
- Calendar must enter as an account adapter distinct from the existing
  time-trigger engine.
- Both must emit exact provider/action evidence and integrate with existing
  approval and release boundaries.

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
- GitHub is the only implemented persisted plugin adapter behind the generic
  plugin runtime contract.
- Generic plugin discovery, typed action execution, confirmation policy and
  audit events are implemented through the runtime `plugins/` layer.
- ChatGPT browser automation is an opt-in execution channel.
- Calendar exists only as a scheduling primitive.
- Gmail and Calendar account adapters are not implemented and must be treated as
  future migration work, not latent product capability.
