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

## iOS Extension Boundary

A future `agent-device` integration must remain an optional provider under the existing `ios` plugin and reuse this interaction lifecycle. It must be version-pinned, reject physical devices by default, preserve current Xcode/simulator readiness when absent, and never start a nested MCP service. Physical iPhone mutation requires a separate device-authorization and safety review.
