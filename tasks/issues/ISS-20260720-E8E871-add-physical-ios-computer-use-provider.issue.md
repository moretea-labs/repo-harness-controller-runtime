---
id: "ISS-20260720-E8E871"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-20T05:51:02.956Z"
source: "repo-harness-controller-v8"
---

# Add physical iOS Computer Use provider

Implement a bounded physical-iPhone interaction provider on top of CoreDevice and the existing interaction-session architecture. Native CoreDevice discovery, installed-app lookup, foreground launch and screenshot are already proven on the paired iPhone; UI tree and input injection must use an explicitly configured signed XCTest/WebDriverAgent-compatible runner and fail closed when unavailable.

## Goals

- Expose paired physical iPhones separately from simulators with honest readiness and limitations.
- Support exact-device installed-app lookup, foreground app launch and native screenshot capture through typed CoreDevice actions.
- Support bounded snapshot, press, non-sensitive fill and scroll only through a signed, explicitly configured XCTest/WebDriverAgent-compatible runner.
- Preserve provider-neutral interaction ownership, serial mutation, bounded evidence, cleanup and sensitive-input redaction.
- Prove the read-only/launch path against the paired iPhone and JD app.

## Non-goals

- No jailbreak, private security bypass, CAPTCHA solving or device-lock bypass.
- No automated password, verification-code, biometric, checkout-submission, purchase or payment confirmation.
- No bundled credentials, certificates, provisioning profiles or pairing records in repository state.
- No regression or semantic expansion of the existing agent-device simulator provider.

## Acceptance Criteria

- [ ] The iOS plugin reports paired physical devices and separates CoreDevice readiness from optional UI-runner readiness.
- [ ] An exact paired device session can verify JD is installed, launch com.360buy.jdmobile and capture a bounded PNG artifact.
- [ ] Ambiguous, unavailable, unpaired or non-iOS devices are rejected with typed actionable errors.
- [ ] Snapshot, press, non-sensitive fill and scroll are exposed only when an explicitly configured signed runner passes readiness; otherwise they fail closed without simulated success.
- [ ] Sensitive targets and purchase/payment flows are blocked or require explicit human handoff.
- [ ] Existing simulator tests remain compatible; focused physical-device tests, typecheck, runtime architecture and controller-v8 pass.

## GitHub

- Not published.

## Tasks

### T1 — Implement bounded CoreDevice physical iOS provider

- Status: `verified`
- Objective: Add a separate ios-device provider reusing the existing durable interaction-session model. Use xcrun devicectl typed JSON for paired-device inventory, installed-app lookup, foreground app launch, screenshot, events and close/session lifecycle. Add an optional explicitly configured XCTest/WebDriverAgent-compatible HTTP runner adapter for UI source/snapshot, tap/press, non-sensitive fill and scroll. Never download or bootstrap third-party automation tooling at runtime; never persist signing or pairing secrets; report runner prerequisites and fail closed when unavailable. Use exact device identity and bundle identifiers, serialize mutating actions, cap/redact evidence, and maintain simulator-provider backward compatibility. Include focused tests, architecture documentation and a live smoke script or command path for discovery, JD lookup, launch and screenshot.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/safe-tooling/**`, `tests/runtime/**`, `docs/architecture/current/**`, `docs/researches/**`, `scripts/**`, `package.json`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `src/runtime/plugins/ios-adapter.ts`
- `src/runtime/plugins/ios-agent-device.ts`
- `src/runtime/plugins/interaction-session.ts`
- `docs/architecture/current/human-interaction-plane.md`
