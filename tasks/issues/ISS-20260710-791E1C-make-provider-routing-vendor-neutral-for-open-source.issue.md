---
id: "ISS-20260710-791E1C"
kind: "governance"
status: "done"
updated_at: "2026-07-10T11:43:10.099Z"
archived_at: "2026-07-10T11:43:10.099Z"
source: "repo-harness-controller-v8"
---

# Make provider routing vendor-neutral for open source

Remove maintainer-specific Grok preference from public defaults while preserving existing controllerHome/user configuration and GUI routing controls.

## Goals

- Derive public default executor routing from capabilities, health and user-configured provider priority instead of preferring Grok by name.
- Preserve existing provider and routing configuration files without resetting user choices.
- Keep GUI provider/routing configuration authoritative and document config locations and precedence.
- Replace provider-specific readiness summaries with neutral configured-provider summaries.

## Non-goals

- Remove Grok support.
- Change provider API implementations or credentials handling.
- Expand the local Task Run agent list beyond its existing supported executors.
- Redesign the Controller GUI.

## Acceptance Criteria

- [ ] A fresh installation has no Grok-specific default repair provider or privileged routing position.
- [ ] Existing controllerHome provider/routing JSON remains authoritative and is not migrated or overwritten.
- [ ] GUI can still enable, disable, prioritize providers and edit per-intent routing orders.
- [ ] Focused provider-routing tests, typecheck, controller-v8 and release-readiness pass.

## GitHub

- Not published.

## Tasks

### T1 — Neutralize provider defaults and routing

- Status: `done`
- Objective: Implement vendor-neutral default provider priority/routing, neutral readiness copy, documentation and focused regression coverage while preserving existing user configuration.
- Depends on: none
- Allowed paths: `src/runtime/control-plane/goal-loop/**`, `src/cli/local-bridge/dashboard.ts`, `src/cli/local-bridge/server.ts`, `tests/runtime/provider-config.test.ts`, `tests/runtime/goal-loop.test.ts`, `tests/cli/controller-chatgpt-bridge-v8.test.ts`, `docs/repo-harness-autonomous-goal-loop.md`, `docs/operations/**`, `README.md`, `README.en.md`, `README.zh-CN.md`
- Checks: `package:check:type`, `package:check:controller-v8`, `package:check:release-readiness`
- Execution hint: selected at runtime

## Related Artifacts

- None.
