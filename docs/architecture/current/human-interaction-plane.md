# Human Interaction Plane

## Purpose

The Human Interaction Plane preserves a provider session while a person completes CAPTCHA, login, two-factor authentication, device unlock, biometric approval, or another step that automation must not perform.

## Current Browser Implementation

```text
bounded plugin action
  -> durable interaction record
  -> detached browser handoff host
  -> visible persistent browser + foreground presentation
  -> explicit resolve_handoff(resume|cancel)
  -> close browser context
  -> write terminal state and release profile
```

The host is not a Controller, scheduler, Gateway, or MCP server. It owns one browser profile and survives the bounded Worker that requested the handoff.

Records live below `.repo-harness/interactions/<provider>/` as atomic session, launch, and command files. They contain provider/session identity, Work ownership, host PID/heartbeat, expiry, bounded URL/title results, and capability-local errors. They never copy cookies, passwords, verification codes, or user-entered form values.

## State and Ownership

```text
starting -> waiting_for_user -> closing -> completed | closed | failed
                         \-----------------> failed
```

- `starting`, `waiting_for_user`, and `closing` own the selected profile.
- Ordinary browser actions and session deletion are rejected while the profile is owned.
- Resume/cancel use separate command files, avoiding concurrent state-file writers.
- Status reads derive stale/dead state without writing files or signalling processes; the next handoff start persists dead-host outcomes and prunes old terminal records to a bounded set.
- The host enforces its own expiry and remains `closing`; the profile is released only after the browser context closes and terminal state is written.
- Final URL/title are saved only after an explicit resume request.

## Security and Failure Isolation

- Existing domain allowlists apply during handoff and again on resume.
- The host uses Playwright foregrounding plus best-effort macOS application activation.
- Human actions are not represented as automated evidence.
- Handoff does not weaken authorization or strong-confirmation requirements for purchases, payment, deletion, or other irreversible actions.
- Host failure is capability-local and must not degrade Controller, repository, or unrelated plugin readiness.

## Public Contract

The browser plugin exposes three actions:

- `request_human_handoff` — start and foreground a saved session.
- `get_handoff_status` — read/reconcile durable state.
- `resolve_handoff` — explicitly resume or cancel.

The small surface limits additional plugin schema growth and avoids alias actions with overlapping semantics.

## Optional iOS Simulator Provider

The existing `ios` plugin includes an optional `agent-device` provider with these boundaries:

- The local CLI must report exactly version `0.19.3`; Repo Harness never downloads it at runtime or adds it as a required package dependency.
- CLI absence or version mismatch degrades only the optional provider. Existing Xcode, `simctl`, build, launch, screenshot, and smoke-review readiness remains unchanged.
- Device inventory comes from typed `agent-device devices --platform ios --json` output. Selection must resolve to exactly one already-booted simulator; physical devices, shutdown simulators, and ambiguous names are rejected before app actions.
- Each interaction receives an isolated `AGENT_DEVICE_STATE_DIR` and explicit session name. Stateful actions are serialized through repository resource claims and only a fixed argv allowlist is exposed; the provider never invokes `agent-device mcp` or arbitrary commands.
- Screenshots stay in Controller-owned artifact storage. JSON responses are capped before entering evidence; event payload fields and direct fill results are redacted.
- Open accepts only an app name or bundle identifier, not a URL or token-bearing deep link. `fill` is limited to non-sensitive text; passwords and verification codes must be entered manually.
- Command failure, explicit close, or the next access after expiry attempts to close the provider session. Terminal state is written only after close succeeds; cleanup failure remains `closing`, keeps simulator ownership fenced, and can be retried through the idempotent close action. Fill arguments and diagnostics are redacted from failure evidence. Provider daemons use a five-second idle timeout and zero iOS runner retention after close.
- Physical iPhone mutation remains outside this provider and requires a separate device-authorization and safety review.
