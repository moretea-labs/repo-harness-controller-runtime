---
id: "ISS-20260719-F77E4C"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-20T03:49:02.241Z"
source: "repo-harness-controller-v8"
---

# Add resumable human interaction plane

Browser foreground human handoff and the optional agent-device 0.19.3 iOS Simulator provider are implemented, locally merged, and verified on final main. Browser and iOS failures remain capability-local; physical devices, automated CAPTCHA solving, nested MCP, arbitrary CLI execution, and tokenized deep links remain outside the capability boundary. Direct-edit tasks are verified but cannot auto-complete because the current task lifecycle requires Agent Run integration/cleanup evidence.

## Goals

- Browser sessions can be presented in the foreground and remain open for manual CAPTCHA/login completion.
- Human handoff state is durable and resumable across plugin actions and Worker lifetimes.
- Existing browser actions refuse conflicting profile use while a handoff host owns the profile.
- The existing iOS plugin gains an optional, version-pinned agent-device simulator provider with typed actions and local evidence.
- Browser and iOS failures remain capability-local and never degrade global Controller readiness.

## Non-goals

- No automated CAPTCHA solving.
- No payment, purchase, account deletion, or other irreversible remote action.
- No physical iPhone mutation support in this change.
- No nested MCP server and no Controller dependency on agent-device.

## Acceptance Criteria

- [ ] Focused browser tests cover foreground presentation, durable handoff state, resume, stale-host recovery, and profile conflict fencing.
- [ ] Focused iOS tests cover absent dependency degradation, exact booted simulator selection, command construction, artifact registration, and close-on-failure.
- [ ] Typecheck and runtime architecture checks pass.
- [ ] Changes are isolated, committed, merged locally, and leave the repository clean.

## GitHub

- Not published.

## Tasks

### T1 — Implement browser human handoff host

- Status: `cancelled`
- Objective: Add a provider-neutral interaction session store and a detached browser handoff host. Expose present_session, request_human_handoff, get_handoff_status, resume_session, and cancel_handoff through the browser plugin. Preserve the existing one-action Playwright model outside handoff, fence profile conflicts, use best-effort macOS foreground activation, capture final URL/title, and clean stale hosts safely.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `tests/runtime/browser-plugin.test.ts`, `docs/architecture/current/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T2 — Add optional agent-device simulator provider

- Status: `superseded`
- Objective: Integrate the proven agent-device PoC as an optional provider inside the existing iOS plugin. Pin version 0.19.3, reject physical devices, require exact uniquely booted simulator names, expose doctor/open/snapshot/press/fill/scroll/screenshot/events/close actions, keep artifacts local/controller-owned, and close sessions on failure. Do not make agent-device required for existing iOS readiness.
- Depends on: `T1`
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/safe-tooling/**`, `tests/runtime/**`, `docs/architecture/current/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T3 — Implement browser human handoff by direct edit

- Status: `verified`
- Objective: Replace cancelled T1 without reusing its failed executor run. Add a provider-neutral interaction session store and a detached browser handoff host. Expose present_session, request_human_handoff, get_handoff_status, resume_session, and cancel_handoff through the browser plugin. Preserve the existing one-action Playwright model outside handoff, fence profile conflicts, use best-effort macOS foreground activation, capture final URL/title, and clean stale hosts safely.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `tests/runtime/browser-plugin.test.ts`, `docs/architecture/current/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T4 — Restore controller-v8 baseline before integration

- Status: `verified`
- Objective: Repair the two controller-v8 failures that independently reproduce on unchanged main and block validation of T3. Diagnose why work_submit(create_issue) fails before the cross-repository request-id conflict assertion; fix the routing or test setup at the true fault. Reconcile the controller full-tool budget with the intentional current surface using a documented exact/derived budget, not a broad unbounded relaxation. Add only focused regression coverage, run package:check:type and package:check:controller-v8, commit and integrate this baseline fix before rebasing T3.
- Depends on: none
- Allowed paths: `src/runtime/gateway/mcp/**`, `src/runtime/execution/**`, `src/cli/mcp/**`, `tests/cli/mcp-controller.test.ts`, `scripts/verify-controller-v8.sh`, `docs/architecture/current/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T5 — Add optional agent-device simulator provider on verified interaction plane

- Status: `superseded`
- Objective: Integrate the existing agent-device PoC as an optional, version-pinned simulator provider under the current iOS plugin and verified interaction-session architecture. Pin 0.19.3, reject physical devices, require an exact uniquely booted simulator, expose bounded doctor/open/snapshot/press/fill/scroll/screenshot/events/close actions, register local artifacts, serialize mutating UI actions, close sessions on failure, and preserve existing Xcode/simulator readiness when the dependency is absent. Do not start a nested MCP server or alter global Controller readiness.
- Depends on: `T3`
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/safe-tooling/**`, `tests/runtime/**`, `docs/architecture/current/**`, `docs/researches/20260716-agent-device-ios-poc.md`, `scripts/agent-device-ios-poc.sh`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T6 — Implement optional agent-device simulator provider from verified main

- Status: `verified`
- Objective: Starting from verified main revision f7afe0e58ca7294f1e982dc86ccced2aa378763a, integrate the existing agent-device PoC as an optional, version-pinned simulator provider under the current iOS plugin and interaction-session architecture. Pin 0.19.3, reject physical devices, require an exact uniquely booted simulator, expose bounded doctor/open/snapshot/press/fill/scroll/screenshot/events/close actions, register local artifacts, serialize mutating UI actions, close sessions on failure, and preserve existing Xcode/simulator readiness when the dependency is absent. Do not start a nested MCP server or alter global Controller readiness.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/safe-tooling/**`, `tests/runtime/**`, `docs/architecture/current/**`, `docs/researches/20260716-agent-device-ios-poc.md`, `scripts/agent-device-ios-poc.sh`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T7 — Add bounded physical iOS device interaction provider

- Status: `ready`
- Objective: Extend the verified iOS plugin and provider-neutral interaction-session architecture with an optional physical-device provider for paired iPhones. Reuse CoreDevice/devicectl for discovery, installed-app lookup, launch and process lifecycle. Establish a signed XCTest/WebDriverAgent-style runner only when required for UI automation. Expose exact-device open/snapshot/press/fill/scroll/screenshot/events/close actions without weakening the existing simulator provider. Support third-party App Store apps such as JD where platform APIs permit it. Keep credentials, pairing records and signing material outside repository state. Serialize mutating actions, redact sensitive fields, require manual handoff for passwords, verification codes, biometric prompts, purchases and payments, and fail closed when screen capture or accessibility control is unavailable. Do not jailbreak, bypass iOS security controls, automate payment confirmation, or claim capabilities not proven on the paired device.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/safe-tooling/**`, `tests/runtime/**`, `docs/architecture/current/**`, `docs/researches/**`, `scripts/**`, `package.json`, `tasks/issues/ISS-20260719-F77E4C-add-resumable-human-interaction-plane.issue.*`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `docs/architecture/current/human-interaction-plane.md`
- `src/runtime/plugins/browser-handoff.ts`
- `src/runtime/plugins/browser-handoff-host.ts`
- `src/runtime/plugins/ios-agent-device.ts`
- `tests/runtime/browser-plugin.test.ts`
- `tests/runtime/ios-agent-device-provider.test.ts`
