---
id: "ISS-20260709-224E71"
kind: "feature"
status: "cancelled"
updated_at: "2026-07-10T13:33:37.745Z"
archived_at: "2026-07-10T13:33:37.745Z"
source: "repo-harness-controller-v8"
---

# ChatGPT handoff inbox and MCP facade architecture

Design and implement the next repo-harness control-plane slice: a Handoff Inbox for ChatGPT continuation, a thin ChatGPT-facing MCP facade, capability routing, and policy-gated execution so plugin capabilities remain parallel to repository operations without expanding ChatGPT's visible tool surface.

## Goals

- Add a durable Handoff Inbox concept that lets repo-harness record pending decisions for ChatGPT/main-controller continuation.
- Define a small ChatGPT-facing facade tool surface for status, inbox, context, work, and evidence-oriented operations.
- Keep repository operations and plugin capabilities parallel internally, routed through capability/policy layers instead of exposing one MCP tool per feature.
- Avoid unsafe or security-flag-prone request shapes by using typed operations, bounded summaries, policy gates, approval requests, and suggested next actions.

## Non-goals

- Do not replace ChatGPT as the strong主控.
- Do not build a low-level clone of Codex.
- Do not expand the public ChatGPT-facing tool list for each new capability.
- Do not modify unrelated browser plugin changes currently dirty on main.

## Acceptance Criteria

- [ ] Architecture documentation explains how plugin capabilities are parallel to repository execution capabilities and how both route through a facade/capability/policy model.
- [ ] A first implementation slice exists for Handoff Inbox and/or facade contracts with bounded result shapes.
- [ ] ChatGPT-facing operations expose stable, limited entry points rather than new per-feature tools.
- [ ] Security and safety considerations are documented: bounded payloads, no raw shell blobs by default, explicit approval for risky operations, and no prompt shapes that ask ChatGPT to bypass security.
- [ ] Targeted checks or type checks are run where available, and the existing unrelated dirty main changes are not overwritten.

## GitHub

- Not published.

## Tasks

### T1 — Document handoff inbox and MCP facade architecture

- Status: `review`
- Objective: Create or update architecture documentation describing Handoff Inbox, thin ChatGPT-facing facade tools, internal capability registry, policy gate, suggested_next_actions, and the separation between repository operations and plugin capabilities.
- Depends on: none
- Allowed paths: `docs/**`, `README.md`
- Checks: `docs`
- Execution hint: selected at runtime

### T2 — Implement handoff/facade MVP contracts

- Status: `review`
- Objective: Add the smallest viable code slice for Handoff Inbox and MCP facade/result contracts, reusing existing controller storage and avoiding broad runtime changes.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T3 — Implement handoff inbox MVP store

- Status: `done`
- Objective: Add a minimal controller-home-backed Handoff Inbox store for creating, listing, reading, acknowledging, and resolving handoff items using the facade contracts without changing existing direct edit, MCP routing, or plugin behavior.
- Depends on: none
- Allowed paths: `src/runtime/control-plane/facade/**`, `tests/runtime/**`, `docs/architecture/chatgpt-handoff-facade.md`
- Checks: `package:check:type`
- Execution hint: selected at runtime

## Related Artifacts

- None.
